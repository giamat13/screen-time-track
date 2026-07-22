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
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  'ms-teams': 'Microsoft Teams',
  outlook: 'Outlook',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  acrobat: 'Adobe Acrobat',
  photoshop: 'Adobe Photoshop',
  obs64: 'OBS Studio',
  vlc: 'VLC'
};

// Chromium-family browsers the bridge extension can run inside.
const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'opera', 'vivaldi']);

// Desktop apps we tag as "on a call" when the foreground.ps1 mic-in-use check
// (registry ConsentStore) comes back true for them.
const CALL_APPS = new Set(['zoom', 'discord', 'whatsapp', 'teams', 'ms-teams', 'slack']);

// Web meeting sites — matched against the active tab's domain (reported by
// the bridge extension) to tag browser time as "on a call" too.
const MEETING_SITES = new Set([
  'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'web.whatsapp.com',
  'discord.com', 'slack.com', 'messenger.com'
]);

// Hostname -> friendly label. Falls back to the bare hostname when unknown.
const SITE_MAP = {
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'netflix.com': 'Netflix',
  'twitch.tv': 'Twitch',
  'github.com': 'GitHub',
  'stackoverflow.com': 'Stack Overflow',
  'google.com': 'Google Search',
  'mail.google.com': 'Gmail',
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'reddit.com': 'Reddit',
  'twitter.com': 'X (Twitter)',
  'x.com': 'X (Twitter)',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'linkedin.com': 'LinkedIn',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'web.whatsapp.com': 'WhatsApp Web',
  'figma.com': 'Figma',
  'notion.so': 'Notion'
};

function siteLabel(domain) {
  if (!domain) return null;
  const d = String(domain).replace(/^www\./, '');
  if (SITE_MAP[d]) return SITE_MAP[d];
  const parts = d.split('.');
  if (parts.length > 2) {
    const base = parts.slice(-2).join('.'); // e.g. m.youtube.com -> youtube.com
    if (SITE_MAP[base]) return SITE_MAP[base];
  }
  return d;
}

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
    this.getPaused = opts.getPaused || (() => false);
    this.getBrowserState = opts.getBrowserState || (() => null);
    this.proc = null;
    this._stopping = false;
    this.lastTs = null;
    this.current = null;
    this.inCall = false;
    this.prevIdle = false;
    // Buffer of recently counted ticks, so that once idle detection actually
    // trips (it can only fire after `idleThreshold` seconds of no input have
    // already elapsed) we can retroactively undo the time wrongly counted
    // during that window instead of leaving it stuck in the total.
    this.recentAdds = [];
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

    let appName = friendlyName(info.name, info.desc);
    const settings = this.store.getSettings();
    const now = Date.now();

    // When a Chromium browser is in front and the bridge extension has a fresh
    // report, attribute time to the actual site (e.g. "YouTube") and note
    // whether a video/track is playing.
    let mediaPlaying = false;
    // "On a call": either a known desktop call app with the mic in use
    // (foreground.ps1's registry check), or a known meeting site in the
    // active browser tab with the extension reporting mic permission granted.
    let inCall = !!(info.name && CALL_APPS.has(info.name.toLowerCase()) && info.mic);
    if (settings.browserDetail !== false && info.name && BROWSERS.has(info.name.toLowerCase())) {
      const bs = this.getBrowserState();
      if (bs) {
        if (bs.active && bs.domain) {
          // Known site → use friendly label; unknown site → use page title.
          const d = String(bs.domain).replace(/^www\./, '');
          const base = d.split('.').slice(-2).join('.');
          const knownLabel = SITE_MAP[d] || SITE_MAP[base];
          if (knownLabel) {
            appName = knownLabel;
          } else {
            appName = (bs.title && bs.title.trim()) ? bs.title.trim() : d;
          }
          // An ad is not "watching", so it does not count as active media.
          mediaPlaying = !!bs.playing && !bs.ad;
          if (bs.micGranted && (MEETING_SITES.has(d) || MEETING_SITES.has(base))) inCall = true;
        } else {
          // Extension is installed but reports no active tab / domain →
          // this is not our session (or a blank tab); don't count as "Chrome".
          appName = null;
        }
      }
    }

    const idleSecs = powerMonitor.getSystemIdleTime();
    let isIdle = idleSecs >= (settings.idleThreshold || 120);
    // Watching a video with no input is still real screen time — keep counting,
    // but only up to a cap: past it we assume you walked away and let it idle,
    // so background ads / autoplay don't pile up time while you're gone.
    if (isIdle && mediaPlaying && settings.countMediaWhenIdle !== false &&
        idleSecs < (settings.mediaIdleCap || 600)) {
      isIdle = false;
    }
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
      const dayKey = this.store.dateKey(new Date(now));
      const hour = new Date(now).getHours();
      const isStudy = !!settings.studyMode;
      this.store.addTime(appName, delta, isStudy);
      this.recentAdds.push({ ts: now, day: dayKey, hour, appName, delta, isStudy });
      this.session.appSecs[appName] = (this.session.appSecs[appName] || 0) + delta;
      this.session.seconds += delta;
      counted = true;
    }
    this.current = appName;
    this.inCall = inCall;

    // Idle detection only trips once `idleThreshold` (or `mediaIdleCap`) seconds
    // of no input have already passed, so the tail of that window was counted
    // before we knew it was idle. The instant we cross into idle, unwind
    // whatever was added since the real idle start (now - idleSecs).
    if (isIdle && !this.prevIdle) {
      this._revertIdlePeriod(idleSecs, now);
    }
    this.prevIdle = isIdle;
    const maxAgeMs = (Math.max(settings.idleThreshold || 120, settings.mediaIdleCap || 600) + 5) * 1000;
    this.recentAdds = this.recentAdds.filter((r) => now - r.ts <= maxAgeMs);

    this.onTick({
      currentApp: appName,
      idle: isIdle,
      idleSecs: Math.round(idleSecs),
      paused,
      counted,
      inCall,
      todaySeconds: this.store.getToday().total,
      session: this.getSessionInfo()
    });
  }

  // Unwind ticks counted after the moment the user actually went idle
  // (now - idleSecs), which were wrongly attributed before the idle
  // threshold had a chance to trip.
  _revertIdlePeriod(idleSecs, now) {
    const idleStart = now - idleSecs * 1000;
    const toRevert = [];
    this.recentAdds = this.recentAdds.filter((rec) => {
      if (rec.ts > idleStart) { toRevert.push(rec); return false; }
      return true;
    });
    for (const rec of toRevert) {
      this.store.subtractTime(rec.day, rec.appName, rec.delta, rec.hour, rec.isStudy);
      this.session.appSecs[rec.appName] = Math.max(0, (this.session.appSecs[rec.appName] || 0) - rec.delta);
      this.session.seconds = Math.max(0, this.session.seconds - rec.delta);
    }
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
    return { currentApp: this.current, inCall: !!this.inCall, session: this.getSessionInfo() };
  }

  stop() {
    this._stopping = true;
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { Tracker, friendlyName, siteLabel };
