const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, nativeImage, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { Tracker } = require('./tracker');

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let tracker = null;
let isQuitting = false;
let locked = false;
let suspended = false;
let lastBlockNotify = 0;

const ASSETS = path.join(__dirname, '..', '..', 'assets');

// ---- single instance ------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  bootstrap();
}

function bootstrap() {
  app.whenReady().then(() => {
    store.load();
    createWindow();
    createTray();
    setupPowerEvents();
    setupIpc();
    applyAutoLaunch(store.getSettings().autoLaunch);
    startTracker();

    if (startHidden || (store.getSettings().minimizeToTray && app.getLoginItemSettings().wasOpenedAtLogin)) {
      if (win) win.hide();
    }
  });

  app.on('window-all-closed', (e) => {
    // keep running in tray; do not quit
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (tracker) tracker.stop();
    store.flush();
  });
}

// ---- window ---------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: !startHidden,
    frame: false,
    backgroundColor: '#0b0c10',
    icon: path.join(ASSETS, 'icon.png'),
    title: 'Screen Time',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('close', (e) => {
    if (!isQuitting && store.getSettings().minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- tray -----------------------------------------------------------------
function trayImage() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.png')) : img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Screen Time');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const tracking = store.getSettings().tracking;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Screen Time', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Tracking',
      type: 'checkbox',
      checked: tracking,
      click: () => setTracking(!tracking)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(tracking ? 'Screen Time — tracking' : 'Screen Time — paused');
}

// ---- power / idle events --------------------------------------------------
function setupPowerEvents() {
  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { suspended = true; });
  powerMonitor.on('resume', () => { suspended = false; });
}

// ---- tracker --------------------------------------------------------------
function isPaused() {
  return !store.getSettings().tracking || locked || suspended;
}

function startTracker() {
  tracker = new Tracker({
    store,
    getPaused: isPaused,
    isBlocked: (appName, procName) => {
      const blocked = store.getBlocked();
      const p = (procName || '').toLowerCase().replace(/\.exe$/, '');
      const label = (appName || '').toLowerCase();
      return blocked.some((b) => b.proc === p || b.label.toLowerCase() === label);
    },
    onBlocked: handleBlocked,
    onTick: (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('tick', payload);
    }
  });
  tracker.start();
}

function handleBlocked({ appName, pid }) {
  if (pid && pid > 4) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
    } catch {}
  }
  const now = Date.now();
  if (now - lastBlockNotify > 4000) {
    lastBlockNotify = now;
    if (Notification.isSupported()) {
      new Notification({
        title: 'App blocked',
        body: `${appName} was closed because it is on your block list.`,
        icon: path.join(ASSETS, 'icon.png')
      }).show();
    }
  }
  if (win && !win.isDestroyed()) win.webContents.send('blocked-hit', { appName });
}

function setTracking(on) {
  store.setSettings({ tracking: !!on });
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('tracking-changed', { tracking: !!on });
}

function applyAutoLaunch(enabled) {
  if (isDev) return; // don't register during development
  try {
    const opts = { openAtLogin: !!enabled };
    if (app.isPackaged) {
      opts.args = ['--hidden'];
    } else {
      // running unpackaged: point the login item at THIS app, not bare electron
      opts.path = process.execPath;
      opts.args = [path.resolve(process.argv[1] || app.getAppPath()), '--hidden'];
    }
    app.setLoginItemSettings(opts);
  } catch (e) {
    console.error('[main] auto-launch failed:', e.message);
  }
}

// ---- dashboard / stats computation ---------------------------------------
const RANGE_DAYS = { Today: 1, '7': 7, '14': 14, '30': 30 };

function computeDashboard(range) {
  const days = RANGE_DAYS[range] || 1;
  const agg = store.rangeData(days);
  const apps = Object.entries(agg.apps)
    .map(([name, sec]) => ({ name, sec: Math.round(sec) }))
    .sort((a, b) => b.sec - a.sec);

  const total = Math.round(agg.total);
  const top = apps[0] || null;
  const denom = days === 1 ? 1 : Math.max(agg.daysWithData, 1);
  const dailyAvg = Math.round(total / denom);

  // usage distribution: top 4 + Others
  const dist = apps.slice(0, 4).map((a) => ({ name: a.name, sec: a.sec }));
  const restSec = apps.slice(4).reduce((s, a) => s + a.sec, 0);
  if (restSec > 0) dist.push({ name: 'Others', sec: restSec });

  const todayTotal = Math.round(store.dayTotal(0));
  const yesterdayTotal = Math.round(store.dayTotal(1));
  let trendPct;
  if (yesterdayTotal > 0) trendPct = Math.round(((todayTotal - yesterdayTotal) / yesterdayTotal) * 100);
  else trendPct = todayTotal > 0 ? 100 : 0;

  const focus = total > 0 && top ? Math.round((top.sec / total) * 100) : 0;

  return {
    range,
    days,
    total,
    appsUsed: apps.length,
    mostUsed: top ? top.name : '—',
    dailyAvg,
    topAppTime: top ? top.sec : 0,
    focus,
    distribution: dist,
    topApplications: apps.slice(0, 8),
    perDay: agg.perDay,
    trend: { today: todayTotal, yesterday: yesterdayTotal, pct: trendPct }
  };
}

function runningApps() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $l = $_.Description; if (-not $l) { $l = $_.ProcessName }; [pscustomobject]@{ proc = $_.ProcessName; label = $l } } | Sort-Object label -Unique | ConvertTo-Json -Compress"
    ], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.on('exit', () => {
      try {
        const parsed = JSON.parse(out || '[]');
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        resolve(arr.filter((a) => a && a.proc).map((a) => ({
          proc: String(a.proc).toLowerCase(),
          label: a.label || a.proc
        })));
      } catch {
        resolve([]);
      }
    });
    ps.on('error', () => resolve([]));
  });
}

// ---- IPC ------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('dashboard:get', (_e, range) => computeDashboard(range));
  ipcMain.handle('stats:get', (_e, range) => computeDashboard(range)); // same payload, richer use in UI
  ipcMain.handle('state:get', () => ({
    tracking: store.getSettings().tracking,
    paused: isPaused(),
    locked,
    ...tracker.getStatus()
  }));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, partial) => {
    const before = store.getSettings();
    const next = store.setSettings(partial);
    if (partial && typeof partial.autoLaunch === 'boolean' && partial.autoLaunch !== before.autoLaunch) {
      applyAutoLaunch(partial.autoLaunch);
    }
    if (partial && typeof partial.tracking === 'boolean') {
      refreshTrayMenu();
      if (win && !win.isDestroyed()) win.webContents.send('tracking-changed', { tracking: partial.tracking });
    }
    return next;
  });
  ipcMain.handle('tracking:set', (_e, on) => { setTracking(on); return store.getSettings().tracking; });
  ipcMain.handle('tracking:toggle', () => { setTracking(!store.getSettings().tracking); return store.getSettings().tracking; });
  ipcMain.handle('session:reset', () => { tracker.resetSession(); return tracker.getStatus(); });

  ipcMain.handle('blocked:list', () => store.getBlocked());
  ipcMain.handle('blocked:add', (_e, entry) => store.addBlocked(entry));
  ipcMain.handle('blocked:remove', (_e, proc) => store.removeBlocked(proc));
  ipcMain.handle('apps:running', () => runningApps());

  ipcMain.handle('win:control', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    return win.isMaximized();
  });
}
