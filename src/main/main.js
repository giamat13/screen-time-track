const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, nativeImage, Notification, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

// Dev runs against a separate userData dir so it has its own single-instance
// lock and data file — that way F5 always launches the dev source independently
// of an installed "Screen Time" build (which otherwise holds the lock and makes
// the dev instance quit and refocus the installed app). Must run before any
// module (store.js) binds a path under userData, and before the lock request.
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'screen-time-track-dev'));
}

const store = require('./store');
const { Tracker } = require('./tracker');
const browserBridge = require('./browserBridge');
const { BreakReminder } = require('./breakReminder');
const { TelegramBot } = require('./telegram');
const { createForestEngine, SPECIES: FOREST_SPECIES, ACHIEVEMENTS: FOREST_ACHIEVEMENTS } = require('./forest');

let win = null;
let tray = null;
let tracker = null;
let forest = null;
let forestTicker = null;
let breakReminder = null;
let telegram = null;
let lockWin = null;
let lockRefocus = null;
let isQuitting = false;
let locked = false;
let suspended = false;
let reminderScheduler = null;
const remindersFired = new Set();

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
    browserBridge.start();
    startTracker();
    startForest();
    startBreakReminder();
    startTelegram();
    startReminderScheduler();

    if (startHidden || (store.getSettings().minimizeToTray && app.getLoginItemSettings().wasOpenedAtLogin)) {
      if (win) win.hide();
    }
  });

  app.on('window-all-closed', (e) => {
    // keep running in tray; do not quit
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (forestTicker) clearInterval(forestTicker);
    if (tracker) tracker.stop();
    if (breakReminder) breakReminder.stop();
    if (telegram) telegram.stop();
    try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
    if (reminderScheduler) clearInterval(reminderScheduler);
    browserBridge.stop();
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

  // When the user enters the app, surface a pending break alarm as the prompt.
  win.on('focus', presentBreakPromptIfRinging);
  win.on('show', presentBreakPromptIfRinging);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// If a break alarm is ringing, show the in-app prompt — but only once the user is
// actually looking at the app (window visible & focused). The beep alone fires in
// the background; the popup waits until you "enter" the app.
function presentBreakPromptIfRinging() {
  if (!breakReminder || !win || win.isDestroyed()) return;
  if (!win.isVisible() || !win.isFocused()) return;
  const st = breakReminder.getStatus();
  if (st.isBeeping) win.webContents.send('break-prompt', st);
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
  return !store.getSettings().tracking || store.getSettings().notMe || locked || suspended;
}

function startBreakReminder() {
  breakReminder = new BreakReminder({
    getSettings: () => store.getSettings(),
    powerMonitor,
    onPrompt: () => {
      // Don't steal focus — just beep. If the user already happens to be in the
      // app, show the prompt now; otherwise it appears when they next focus it.
      presentBreakPromptIfRinging();
    },
    showLock: (state) => showLock(state),
    updateLock: (state) => updateLock(state),
    hideLock: () => hideLock(),
    sendTelegram: (text) => { if (telegram) telegram.sendToAll(text); },
    notify: (title, body) => { try { new Notification({ title, body }).show(); } catch (e) { /* headless */ } },
  });
  breakReminder.start();
}

function startTelegram() {
  telegram = new TelegramBot({
    getConfig: () => (store.getSettings().breakReminder || {}).telegram || {},
    onMessage: (msg) => {
      // A veto from a watcher re-locks / re-beeps based on how fast it arrived.
      if (msg && msg.negative && breakReminder) breakReminder.onTelegramVeto();
    },
    onCommand: (cmd) => {
      // /lock does exactly what a break reminder firing does.
      if (cmd === 'lock' && breakReminder) {
        breakReminder.forcePrompt();
        presentBreakPromptIfRinging();
      }
    },
  });
  telegram.refresh();
}

// Deliver the one-time "here's what this bot does" message the first time the
// watcher list is configured with a working token + at least one chat.
function maybeSendTelegramIntro() {
  const tg = (store.getSettings().breakReminder || {}).telegram || {};
  if (!tg.enabled || !tg.botToken || !(tg.chatIds || []).length || tg.introSent) return;
  if (!telegram) return;
  const intro =
    '👋 You were added as a Screen Time watcher.\n\n' +
    'When this person presses "approve me to keep playing", you\'ll get a message here. ' +
    'If they should NOT keep playing, reply /cancel — or a keyword like "no", "stop", ' +
    '"אסור", "לא". The faster you reply, the harder it locks their computer back.\n\n' +
    'You can also send /lock at any time to make them take a break now.';
  telegram.sendToAll(intro).then((ok) => {
    if (ok) store.setSettings({ breakReminder: { telegram: { introSent: true } } });
  });
}

// ---- fullscreen kiosk lock -------------------------------------------------
// Best-effort inescapable lock: fullscreen kiosk window pinned above everything,
// re-grabbing focus, with common escape shortcuts swallowed. Note: the Windows
// Secure Attention Sequence (Ctrl+Alt+Del) cannot be blocked from user space
// without a kernel driver — everything else here is defence-in-depth.
const LOCK_SHORTCUTS = [
  'Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Super', 'CommandOrControl+W',
  'CommandOrControl+Shift+W', 'CommandOrControl+Esc', 'Alt+Esc', 'Alt+Space',
  'CommandOrControl+Shift+Esc', 'CommandOrControl+Tab', 'CommandOrControl+Shift+Tab',
  'F11',
];

function registerLockShortcuts() {
  for (const acc of LOCK_SHORTCUTS) {
    try { globalShortcut.register(acc, () => {}); } catch (e) { /* not all combos are registerable */ }
  }
}

function unregisterLockShortcuts() {
  for (const acc of LOCK_SHORTCUTS) {
    try { globalShortcut.unregister(acc); } catch (e) { /* ignore */ }
  }
}

function showLock(state) {
  if (lockWin && !lockWin.isDestroyed()) { updateLock(state); return; }
  lockWin = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    closable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    resizable: false,
    backgroundColor: '#07080c',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockWin.setAlwaysOnTop(true, 'screen-saver');
  try { lockWin.setVisibleOnAllWorkspaces(true); } catch (e) { /* platform */ }
  lockWin.loadFile(path.join(__dirname, '..', 'renderer', 'lock.html'));

  // Refuse to close while a lock is actually in force.
  lockWin.on('close', (e) => {
    if (breakReminder && breakReminder.getStatus().isLocked) e.preventDefault();
  });

  // Swallow modifier-driven escapes inside the window itself.
  lockWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt || input.meta) { e.preventDefault(); return; }
    if (['F4', 'Escape', 'Tab', 'F11', 'Meta'].includes(input.key)) e.preventDefault();
  });

  registerLockShortcuts();

  // Keep re-asserting focus + top-most so nothing can sit in front of the lock.
  if (lockRefocus) clearInterval(lockRefocus);
  lockRefocus = setInterval(() => {
    if (!lockWin || lockWin.isDestroyed()) return;
    lockWin.setAlwaysOnTop(true, 'screen-saver');
    if (!lockWin.isFocused()) { try { lockWin.show(); lockWin.focus(); } catch (e) { /* ignore */ } }
  }, 700);
}

function updateLock(state) {
  if (lockWin && !lockWin.isDestroyed()) lockWin.webContents.send('lock:tick', state);
}

function hideLock() {
  unregisterLockShortcuts();
  if (lockRefocus) { clearInterval(lockRefocus); lockRefocus = null; }
  if (lockWin && !lockWin.isDestroyed()) {
    const w = lockWin;
    lockWin = null;
    try { w.setClosable(true); } catch (e) { /* ignore */ }
    try { w.destroy(); } catch (e) { /* ignore */ }
  } else {
    lockWin = null;
  }
}

function startTracker() {
  tracker = new Tracker({
    store,
    getPaused: isPaused,
    getBrowserState: () => browserBridge.getState(),
    onTick: (payload) => {
      if (forest && payload && payload.currentApp) forest.onForegroundApp(payload.currentApp);
      if (win && !win.isDestroyed()) win.webContents.send('tick', payload);
    }
  });
  tracker.start();
}

// ---- forest focus sessions -------------------------------------------------
function startForest() {
  forest = createForestEngine({
    store,
    notify: (title, body) => {
      try { new Notification({ title, body }).show(); } catch (e) { /* headless */ }
    },
    sendEvent: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });
  // A leftover snapshot means the app was killed mid-session — that tree died.
  const crashed = forest.recoverCrashed();
  if (crashed) {
    try { new Notification({ title: 'Your tree died 🥀', body: 'The app closed during your focus session.' }).show(); } catch (e) { /* ignore */ }
  }
  forestTicker = setInterval(() => forest.tick(), 1000);
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

// ---- scheduled reminders --------------------------------------------------
function startReminderScheduler() {
  reminderScheduler = setInterval(checkReminders, 30000);
}

function checkReminders() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateStr = store.dateKey(now);
  for (const r of store.getReminders()) {
    if (!r.enabled || r.time !== hhmm) continue;
    const key = `${dateStr}|${r.id}`;
    if (remindersFired.has(key)) continue;
    remindersFired.add(key);
    openReminderPopup(r);
  }
}

function openReminderPopup(r) {
  const popup = new BrowserWindow({
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#0b0c10',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'reminder-popup.html'), {
    query: { message: r.message || 'Reminder!', time: r.time || '' }
  });
}

// ---- dashboard / stats computation ---------------------------------------
const RANGE_DAYS = { Today: 1, '7': 7, '14': 14, '30': 30 };

function computeDashboard(range, offset = 0, filter = 'all') {
  const days = RANGE_DAYS[range] || 1;
  // offset is measured in whole windows; back one window = `days` days earlier.
  const endOffset = Math.max(0, offset) * days;
  const agg = store.rangeData(days, endOffset);
  const studyApps = agg.studyApps || {};
  // filter: 'all' = everything, 'play' = exclude study time, 'study' = only study time
  const appSec = (name, sec) => {
    if (filter === 'play') return sec - (studyApps[name] || 0);
    if (filter === 'study') return studyApps[name] || 0;
    return sec;
  };
  const apps = Object.entries(agg.apps)
    .map(([name, sec]) => ({ name, sec: Math.round(appSec(name, sec)) }))
    .filter((a) => a.sec > 0)
    .sort((a, b) => b.sec - a.sec);

  const studyTotal = Math.round(agg.study || 0);
  const total = filter === 'play' ? Math.round(agg.total) - studyTotal
    : filter === 'study' ? studyTotal
    : Math.round(agg.total);
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
    filter,
    studyTotal,
    offset: Math.max(0, offset),
    rangeStart: agg.perDay.length ? agg.perDay[0].date : null,
    rangeEnd: agg.perDay.length ? agg.perDay[agg.perDay.length - 1].date : null,
    total,
    appsUsed: apps.length,
    mostUsed: top ? top.name : '—',
    dailyAvg,
    topAppTime: top ? top.sec : 0,
    focus,
    distribution: dist,
    topApplications: apps.slice(0, 8),
    perDay: agg.perDay,
    hours: agg.hours,
    dayOfWeek: store.dayOfWeekStats(30),
    trendAnalysis: store.trendAnalysis(),
    trend: { today: todayTotal, yesterday: yesterdayTotal, pct: trendPct }
  };
}

// ---- IPC ------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('dashboard:get', (_e, range, offset, filter) => computeDashboard(range, offset, filter));
  ipcMain.handle('stats:get', (_e, range, offset, filter) => computeDashboard(range, offset, filter)); // same payload, richer use in UI
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
    if (partial && partial.breakReminder && breakReminder) {
      breakReminder.restart();
    }
    if (partial && partial.breakReminder && partial.breakReminder.telegram && telegram) {
      telegram.refresh();
      maybeSendTelegramIntro();
    }
    return next;
  });

  ipcMain.handle('breaks:testBeep', () => { if (breakReminder) breakReminder.testBeep(); });
  ipcMain.handle('breaks:getStatus', () => breakReminder ? breakReminder.getStatus() : { isBeeping: false, nextCheckAt: null });
  ipcMain.handle('breaks:respond', (_e, choice) => breakReminder ? breakReminder.respond(choice) : { isBeeping: false, nextCheckAt: null });
  ipcMain.handle('breaks:force', () => { if (breakReminder) { breakReminder.forcePrompt(); presentBreakPromptIfRinging(); } });
  ipcMain.handle('breaks:telegramTest', async () => {
    if (!telegram) return { ok: false };
    const ok = await telegram.sendToAll('✅ Screen Time test message — you are set up to receive alerts.');
    return { ok };
  });

  ipcMain.handle('lock:getState', () => breakReminder ? breakReminder.getLockState() : { locked: false });
  ipcMain.handle('lock:approve', () => breakReminder ? breakReminder.approveFromLock() : { locked: false });
  ipcMain.handle('lock:debugExit', () => breakReminder ? breakReminder.debugExit() : { locked: false });

  ipcMain.handle('goals:get', () => store.getGoals());
  ipcMain.handle('goals:set', (_e, appName, targetSec) => store.setGoal(appName, targetSec));
  ipcMain.handle('limit:getGlobal', () => store.getGlobalLimit());
  ipcMain.handle('limit:setGlobal', (_e, seconds) => store.setGlobalLimit(seconds));
  ipcMain.handle('streaks:get', () => store.getStreaks());
  ipcMain.handle('weekly:get', () => store.weeklyReport());
  ipcMain.handle('tracking:set', (_e, on) => { setTracking(on); return store.getSettings().tracking; });
  ipcMain.handle('tracking:toggle', () => { setTracking(!store.getSettings().tracking); return store.getSettings().tracking; });
  ipcMain.handle('session:reset', () => { tracker.resetSession(); return tracker.getStatus(); });
  ipcMain.handle('debug:subtractTime', (_e, seconds) => store.debugSubtractToday(seconds));

  ipcMain.handle('notme:start', (_e, name) => {
    store.setSettings({ notMe: true });
    return store.startOtherUser(name);
  });
  ipcMain.handle('notme:end', () => {
    store.setSettings({ notMe: false });
    return store.endOtherUser();
  });
  ipcMain.handle('notme:log', () => store.getOtherUsersLog());


  ipcMain.handle('reminders:get', () => store.getReminders());
  ipcMain.handle('reminders:set', (_e, r) => store.setReminder(r));
  ipcMain.handle('reminders:delete', (_e, id) => store.deleteReminder(id));

  ipcMain.handle('habits:get', () => store.getHabits());
  ipcMain.handle('habits:add', (_e, h) => store.addHabit(h));
  ipcMain.handle('habits:update', (_e, id, partial) => store.updateHabit(id, partial));
  ipcMain.handle('habits:delete', (_e, id) => store.deleteHabit(id));
  ipcMain.handle('habits:log', (_e, id, amount, when) => store.logHabit(id, amount, when));
  ipcMain.handle('habits:pause', (_e, id) => store.toggleHabitPause(id));
  ipcMain.handle('debug:addHabitFreezers', (_e, id, count) => store.debugAddHabitFreezers(id, count));

  // ---- forest ----
  ipcMain.handle('forest:getState', () => ({
    session: forest.liveView(),
    data: store.getForestData(),
    species: FOREST_SPECIES,
    achievementDefs: FOREST_ACHIEVEMENTS
  }));
  ipcMain.handle('forest:start', (_e, opts) => forest.start(opts || {}));
  ipcMain.handle('forest:pause', () => forest.pause());
  ipcMain.handle('forest:resume', () => forest.resume());
  ipcMain.handle('forest:giveup', () => forest.giveup());
  ipcMain.handle('forest:finish', () => forest.finish());
  ipcMain.handle('forest:buySpecies', (_e, id) => {
    const sp = FOREST_SPECIES.find((s) => s.id === id);
    if (!sp) return { ok: false, reason: 'unknown' };
    const res = store.forestBuySpecies(id, sp.price);
    if (res.ok) forest.checkAchievements(); // species-4
    return res;
  });
  ipcMain.handle('forest:selectSpecies', (_e, id) => store.forestSelectSpecies(id));
  ipcMain.handle('forest:setDistractions', (_e, d) => store.forestSetDistractions(d || {}));
  ipcMain.handle('forest:setTags', (_e, tags) => store.forestSetTags(tags));
  ipcMain.handle('forest:setSettings', (_e, partial) => store.forestSetSettings(partial));
  ipcMain.handle('forest:tasks:add', (_e, title) => store.forestAddTask(title));
  ipcMain.handle('forest:tasks:toggle', (_e, id) => {
    const t = store.forestToggleTask(id);
    if (t && t.done) forest.checkAchievements(); // tasks-10
    return t;
  });
  ipcMain.handle('forest:tasks:delete', (_e, id) => store.forestDeleteTask(id));

  ipcMain.handle('win:control', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    return win.isMaximized();
  });
}
