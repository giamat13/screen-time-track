// Foreground-window tracker. Spawns the persistent PowerShell watcher,
// attributes elapsed time to the active app, and skips time while the user
// is idle / the session is paused.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { powerMonitor } = require('electron');

const NAME_MAP = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  brave: 'Brave',
  opera: 'Opera',
  code: 'VS Code',
  'code - insiders': 'VS Code Insiders',
  devenv: 'Visual Studio',
  explorer: 'File Explorer',
  winrar: 'WinRAR',
  '7zfm': '7-Zip',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  cmd: 'Command Prompt',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  windowsterminal: 'Windows Terminal',
  electron: 'Screen Time',
  'screen time': 'Screen Time',
  spotify: 'Spotify',
  discord: 'Discord',
  slack: 'Slack',
  steam: 'Steam',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  outlook: 'Outlook',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  acrobat: 'Adobe Acrobat',
  photoshop: 'Adobe Photoshop',
  obs64: 'OBS Studio',
  vlc: 'VLC'
};

function titleCase(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function friendlyName(name, desc) {
  if (!name) return null;
  const key = name.toLowerCase();
  if (NAME_MAP[key]) return NAME_MAP[key];
  if (desc && desc.trim()) {
    const d = desc.trim();
    if (d.length <= 42 && !/^@\{|microsoft® |®/i.test(d)) return d;
  }
  return titleCase(name);
}

function scriptPath() {
  let p = path.join(__dirname, 'foreground.ps1');
  if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

class Tracker {
  constructor(opts) {
    this.store = opts.store;
    this.onTick = opts.onTick || (() => {});
    this.isBlocked = opts.isBlocked || (() => false);
    this.onBlocked = opts.onBlocked || (() => {});
    this.getPaused = opts.getPaused || (() => false);
    this.proc = null;
    this._stopping = false;
    this.lastTs = null;
    this.current = null;
    this.resetSession();
  }

  resetSession() {
    this.session = { startedAt: new Date().toISOString(), appSecs: {}, seconds: 0 };
    this.lastTs = null;
  }

  start() {
    this._spawn();
  }

  _spawn() {
    const interval = this.store.getSettings().pollInterval || 2;
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath(), String(interval)
    ];
    try {
      this.proc = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      console.error('[tracker] failed to spawn watcher:', e.message);
      return;
    }
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      this.proc = null;
      if (!this._stopping) setTimeout(() => this._spawn(), 2000); // auto-restart
    });
  }

  _onLine(line) {
    line = (line || '').trim();
    if (!line || line[0] !== '{') return;
    let info;
    try { info = JSON.parse(line); } catch { return; }
    if (info.error) return;

    const appName = friendlyName(info.name, info.desc);
    const settings = this.store.getSettings();
    const now = Date.now();

    // Blocking takes priority and runs regardless of idle / pause.
    if (appName && settings.blockingEnabled && this.isBlocked(appName, info.name)) {
      this.onBlocked({ appName, name: info.name, pid: info.pid });
      this.lastTs = now;
      this.current = appName;
      return;
    }

    const idleSecs = powerMonitor.getSystemIdleTime();
    const isIdle = idleSecs >= (settings.idleThreshold || 120);
    const paused = this.getPaused();

    let delta = 0;
    if (this.lastTs) {
      delta = (now - this.lastTs) / 1000;
      const cap = (settings.pollInterval || 2) * 3;
      if (delta < 0) delta = 0;
      if (delta > cap) delta = settings.pollInterval || 2;
    }
    this.lastTs = now;

    let counted = false;
    if (appName && !paused && !isIdle && delta > 0) {
      this.store.addTime(appName, delta);
      this.session.appSecs[appName] = (this.session.appSecs[appName] || 0) + delta;
      this.session.seconds += delta;
      counted = true;
    }
    this.current = appName;

    this.onTick({
      currentApp: appName,
      idle: isIdle,
      paused,
      counted,
      todaySeconds: this.store.getToday().total,
      session: this.getSessionInfo()
    });
  }

  getSessionInfo() {
    const secs = Object.values(this.session.appSecs);
    const top = secs.length ? Math.max(...secs) : 0;
    const focus = this.session.seconds > 0 ? Math.round((top / this.session.seconds) * 100) : 0;
    return {
      startedAt: this.session.startedAt,
      apps: Object.keys(this.session.appSecs).length,
      seconds: Math.round(this.session.seconds),
      focus
    };
  }

  getStatus() {
    return { currentApp: this.current, session: this.getSessionInfo() };
  }

  stop() {
    this._stopping = true;
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { Tracker, friendlyName };
