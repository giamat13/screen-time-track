const { spawn } = require('child_process');

const AWAY_RESET_MS = 5 * 60 * 1000;  // away this long → the presence timer resets to full

// The break/lock engine.
//
// Responsibilities:
//   1. Presence timer — counts down while you're at the computer; when it hits
//      zero it starts the alarm ("beeping") and asks you to take a break.
//   2. Beep engine — a PowerShell [Console]::Beep loop with a timeout. Every
//      beeping phase has a deadline; ignore it and it locks the machine.
//   3. Lock state machine — drives a fullscreen kiosk lock window (created in
//      main.js via the injected showLock/updateLock/hideLock callbacks).
//   4. Telegram escalation — pressing "approve me to keep playing" pings the
//      watchers; a veto reply from them re-locks / re-beeps based on how fast
//      it arrived.
//
// main.js owns the actual BrowserWindow and Telegram client and injects them
// as callbacks, so this module stays free of Electron imports.
class BreakReminder {
  constructor({ isDev, getSettings, powerMonitor, onPrompt, showLock, updateLock, hideLock, sendTelegram, notify, persistLock, clearLock }) {
    this._isDev = !!isDev;
    this._getSettings = getSettings;
    this._pm = powerMonitor;
    this._onPrompt = fn(onPrompt);
    this._showLock = fn(showLock);
    this._updateLock = fn(updateLock);
    this._hideLock = fn(hideLock);
    this._sendTelegram = fn(sendTelegram);   // (text) => void, pings the watchers
    this._notify = fn(notify);
    this._persistLock = fn(persistLock);     // (state) => void, durably record an in-force break lock
    this._clearLock = fn(clearLock);         // () => void, erase the persisted break lock

    this._tick = null;                        // master 1s interval
    this._beepProc = null;

    this._mode = 'idle';                      // 'idle' | 'beeping' | 'locked'

    // presence timer
    this._remainingMs = null;                 // ms left (null = not started / reset)
    this._lastTickAt = null;
    this._awayAt = null;

    // beeping phase
    this._beepUntilAt = null;                 // when the beep phase auto-locks
    this._beepOnTimeout = null;               // () => void
    this._promptPhase = 'reminder';           // 'reminder' | 'escalation'
    this._allowApprove = true;                // show the approve button in the prompt?

    // lock phase
    this._lockMode = null;                    // 'break' | 'approve-short'
    this._lockStartAt = null;
    this._lockUntilAt = null;
    this._lockApproved = false;               // approve pressed on the lock screen already

    // telegram escalation
    this._approveSentAt = null;               // when the last "approve me" ping went out
    this._escalationArmed = false;
  }

  start() { if (!this._tick) this._tick = setInterval(() => this._onTick(), 1000); }

  stop() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this._killBeepProc();
    this._hideLock();
    this._mode = 'idle';
    this._remainingMs = null;
    this._lastTickAt = null;
    this._awayAt = null;
    this._beepUntilAt = null;
    this._beepOnTimeout = null;
    this._lockMode = null;
    this._lockStartAt = null;
    this._lockUntilAt = null;
    this._lockApproved = false;
    this._escalationArmed = false;
    this._approveSentAt = null;
  }

  // Settings changed — keep the loop alive but forget an in-flight presence
  // countdown so new intervals take effect. Never yank an active lock/beep.
  restart() {
    if (this._mode === 'idle') { this._remainingMs = null; this._lastTickAt = null; }
    this.start();
  }

  // Re-engage a break lock that was still in force when the app last exited — a
  // crash, a normal quit, or a full power-off. Called once at startup with
  // whatever was persisted. The stored end time is absolute wall-clock, so time
  // spent powered off already counted toward the break: if the whole break
  // elapsed while off there's nothing left to lock, otherwise we lock for the
  // remainder. Rebooting to escape therefore buys nothing.
  resumeLock(saved) {
    if (!saved || saved.mode !== 'break') return false;
    const until = int(saved.lockUntilAt, 0);
    if (until - Date.now() <= 0) { this._clearLock(); return false; } // break already over
    this.start();
    this._mode = 'locked';
    this._lockMode = 'break';
    this._lockStartAt = Date.now();
    this._lockUntilAt = until;           // keep the original absolute end — off-time counted
    this._lockApproved = false;
    this._escalationArmed = false;
    this._persistBreakLock();
    this._showLock(this.getLockState());
    return true;
  }

  testBeep() {
    const s = this._brk();
    const script = `try{[Console]::Beep(${int(s.beepFrequency, 1000)},${int(s.beepDuration, 200)})}catch{}`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      .on('error', () => {});
  }

  getStatus() {
    const s = this._brk();
    return {
      isBeeping: this._mode === 'beeping',
      isLocked: this._mode === 'locked',
      mode: this._mode,
      nextCheckAt: this._mode === 'idle' && this._remainingMs !== null
        ? Date.now() + Math.max(0, this._remainingMs) : null,
      recommendedBreakMinutes: int(s.breakLockMinutes, 5),
      telegramReady: !!(s.telegram && s.telegram.enabled && s.telegram.botToken && (s.telegram.chatIds || []).length),
    };
  }

  // Payload for the in-app prompt shown when the alarm is ringing.
  promptPayload() {
    const s = this._brk();
    return {
      phase: this._promptPhase,
      allowApprove: this._allowApprove && !!(s.telegram && s.telegram.enabled),
      recommendedBreakMinutes: int(s.breakLockMinutes, 5),
      isBeeping: this._mode === 'beeping',
    };
  }

  // ---- external commands ---------------------------------------------------

  // "test the flow" (debug button) or a watcher's /lock — behave like the
  // presence timer firing. A watcher's /lock is a deliberate override, so it
  // doesn't offer the "approve me" escape valve the way a normal timer does.
  forcePrompt(allowApprove = true) {
    if (this._mode === 'locked') return this.getStatus();
    this._startBeeping({ phase: 'reminder', allowApprove, timeoutMs: this._ignoreBeepMs(), onTimeout: () => this._lock('break') });
    return this.getStatus();
  }

  // Answer the in-app prompt. choice ∈ 'break' | 'approve' | 'lockNow'.
  respond(choice, reason) {
    if (choice === 'break' || choice === 'lockNow') {
      this._lock('break');
    } else if (choice === 'approve') {
      this._approveFromPrompt(reason);
    }
    return this.getStatus();
  }

  // Approve button pressed *on the lock screen* (during a full break lock).
  approveFromLock(reason) {
    if (this._mode !== 'locked' || this._lockMode !== 'break') return this.getLockState();
    const s = this._brk();
    const minMs = int(s.approveMinLockSeconds, 20) * 1000;
    const elapsed = Date.now() - (this._lockStartAt || Date.now());
    this._approveSend(reason);           // ping watchers + arm escalation
    this._lockApproved = true;
    if (elapsed >= minMs) {
      this._unlock();                    // already stood up long enough
    } else {
      // shorten the countdown to the remaining seconds needed to reach the
      // minimum — without resetting it back up to the full minimum.
      this._lockUntilAt = (this._lockStartAt || Date.now()) + minMs;
      this._persistBreakLock();          // keep the persisted end time in sync
    }
    return this.getLockState();
  }

  // Panic escape ("release the computer") — dev-mode only, so a test run can
  // never trap the developer. Gated behind isDev because it makes the lock
  // trivially defeatable by anyone at the keyboard.
  release() {
    if (!this._isDev) return this.getLockState();
    this._unlock();
    this._escalationArmed = false;
    return { locked: false };
  }

  getLockState() {
    if (this._mode !== 'locked') return { locked: false };
    const s = this._brk();
    const now = Date.now();
    const minMs = int(s.approveMinLockSeconds, 20) * 1000;
    const elapsed = now - (this._lockStartAt || now);
    const isBreak = this._lockMode === 'break';
    return {
      locked: true,
      mode: this._lockMode,
      remainingMs: Math.max(0, (this._lockUntilAt || now) - now),
      totalMs: Math.max(0, (this._lockUntilAt || now) - (this._lockStartAt || now)),
      showApprove: isBreak && !this._lockApproved && !!(s.telegram && s.telegram.enabled),
      canApproveNow: elapsed >= minMs,
      minApproveSeconds: int(s.approveMinLockSeconds, 20),
      isDev: this._isDev,
    };
  }

  // A negative / veto reply (/cancel or a keyword) arrived from a watcher on
  // Telegram. Acts like /lock — always forces something, no arming required —
  // but still checks the times: if it's answering a live "approve me" ping,
  // the response severity scales with how fast it came; standalone (no ping
  // pending) it's instant, same as /lock.
  onTelegramVeto() {
    this._escalationArmed = false;
    const s = this._brk();
    const elapsedMs = this._approveSentAt ? Date.now() - this._approveSentAt : 0;

    if (elapsedMs <= int(s.cancelWindowSeconds, 10) * 1000) {
      this._lock('break');                 // instant veto
      return;
    }
    let beepSec;
    if (elapsedMs <= int(s.tier1Minutes, 1) * 60000) beepSec = int(s.tier1BeepSeconds, 30);
    else if (elapsedMs <= int(s.tier2Minutes, 5) * 60000) beepSec = int(s.tier2BeepSeconds, 60);
    else if (elapsedMs <= int(s.tier3Minutes, 10) * 60000) beepSec = int(s.tier3BeepSeconds, 300);
    else beepSec = int(s.tier3PlusBeepSeconds, 300);

    // Beep for a grace period, then lock — unless the user enters the app and
    // chooses to take a break (or lock now) before the timeout.
    this._startBeeping({ phase: 'escalation', allowApprove: false, timeoutMs: beepSec * 1000, onTimeout: () => this._lock('break') });
  }

  // ---- internals -----------------------------------------------------------

  _brk() { return (this._getSettings() || {}).breakReminder || {}; }

  _ignoreBeepMs() {
    const s = this._brk();
    if (s.devMode) return Math.max(3000, int(s.checkIntervalSeconds, 10) * 1000);
    return int(s.ignoreBeepMinutes, 5) * 60 * 1000;
  }

  _baseIntervalMs() {
    const s = this._brk();
    if (s.devMode) return Math.max(1, int(s.checkIntervalSeconds, 10)) * 1000;
    return int(s.checkIntervalMinutes, 60) * 60 * 1000;
  }

  // reason is required at the UI level (see renderer.js / lock.js) so watchers
  // never have to come ask what's going on — it's right there in the ping.
  _approveSend(reason) {
    const s = this._brk();
    const mins = int(s.breakLockMinutes, 5);
    const reasonText = (reason || '').trim() || '(no reason given)';
    this._sendTelegram(
      `🎮 "Approve me to keep playing" was just pressed on Screen Time.\n` +
      `Reason: ${reasonText}\n` +
      `Reply /cancel (or: no / אסור / לא / stop) if they should NOT keep playing.\n` +
      `The sooner you reply, the harder it locks back.`
    );
    this._approveSentAt = Date.now();
    this._escalationArmed = true;
    this._notify('Watchers notified', 'They were pinged on Telegram. A veto will lock you back.');
    void mins;
  }

  _approveFromPrompt(reason) {
    this._approveSend(reason);
    this._lock('approve-short');
  }

  // Master 1s tick — one of three modes is active.
  _onTick() {
    if (this._mode === 'locked') return this._tickLock();
    if (this._mode === 'beeping') return this._tickBeep();
    return this._tickPresence();
  }

  _tickLock() {
    const now = Date.now();
    if (this._lockUntilAt !== null && now >= this._lockUntilAt) {
      this._unlock();
      return;
    }
    this._updateLock(this.getLockState());
  }

  _tickBeep() {
    if (this._beepUntilAt !== null && Date.now() >= this._beepUntilAt) {
      const cb = this._beepOnTimeout;
      this._beepOnTimeout = null;
      if (cb) cb(); else this._stopBeeping();
    }
  }

  // The presence model:
  //   1. While you're at the computer, the timer counts down.
  //   2. The moment you leave, it pauses (frozen at whatever was left).
  //   3. Away 5+ minutes → it resets to full for when you return.
  _tickPresence() {
    const settings = this._getSettings() || {};
    const s = settings.breakReminder || {};
    if (!s.enabled) {
      this._remainingMs = null; this._lastTickAt = null; this._awayAt = null;
      return;
    }

    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = settings.studyMode ? 0 : this._pm.getSystemIdleTime();
    const now = Date.now();
    const elapsed = this._lastTickAt === null ? 0 : now - this._lastTickAt;
    this._lastTickAt = now;

    if (idleSecs >= idleThreshold) {
      if (this._awayAt === null) {
        this._awayAt = now - idleSecs * 1000;
        if (this._remainingMs !== null) {
          this._remainingMs = Math.min(this._baseIntervalMs(), this._remainingMs + idleSecs * 1000);
        }
      }
      if (now - this._awayAt >= AWAY_RESET_MS) { this._remainingMs = null; }
      return;
    }

    this._awayAt = null;
    if (this._remainingMs === null) this._remainingMs = this._baseIntervalMs();
    else this._remainingMs -= elapsed;

    if (this._remainingMs <= 0) {
      this._startBeeping({ phase: 'reminder', allowApprove: true, timeoutMs: this._ignoreBeepMs(), onTimeout: () => this._lock('break') });
    }
  }

  _startBeeping({ phase, allowApprove, timeoutMs, onTimeout }) {
    // Restart the beep loop cleanly even if one is already running (e.g. a
    // reminder beep escalating into a veto beep).
    this._killBeepProc();
    this._mode = 'beeping';
    this._promptPhase = phase;
    this._allowApprove = allowApprove;
    this._beepUntilAt = timeoutMs ? Date.now() + timeoutMs : null;
    this._beepOnTimeout = onTimeout || (() => this._stopBeeping());

    const s = this._brk();
    const freq = int(s.beepFrequency, 1000);
    const dur = int(s.beepDuration, 200);
    const interval = Math.round(num(s.beepIntervalSeconds, 0.4) * 1000);
    const script = `while($true){try{[Console]::Beep(${freq},${dur})}catch{};Start-Sleep -Milliseconds ${interval}}`;
    this._beepProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, detached: false });
    this._beepProc.on('error', () => {});
    this._beepProc.on('exit', () => { this._beepProc = null; });

    this._onPrompt(this.promptPayload());
  }

  _stopBeeping() {
    this._killBeepProc();
    this._beepUntilAt = null;
    this._beepOnTimeout = null;
    if (this._mode === 'beeping') {
      this._mode = 'idle';
      this._remainingMs = null;      // restart presence countdown from scratch
      this._lastTickAt = null;
    }
  }

  // Enter a fullscreen kiosk lock.
  //   'break'         — the real break; approve (min-lock) + debug buttons.
  //   'approve-short' — brief "get up and check" lock after pressing approve.
  _lock(mode) {
    this._killBeepProc();
    this._beepUntilAt = null;
    this._beepOnTimeout = null;
    if (mode === 'break') this._escalationArmed = false; // taking the real break clears any pending veto

    const s = this._brk();
    let durMs;
    if (mode === 'break') {
      // In dev mode the break lock is seconds (same clock as the presence timer),
      // never the real 5 minutes — otherwise a quick test traps you for real.
      durMs = s.devMode ? this._baseIntervalMs() : int(s.breakLockMinutes, 5) * 60 * 1000;
    } else durMs = int(s.approveShortLockSeconds, 10) * 1000;

    this._mode = 'locked';
    this._lockMode = mode;
    this._lockStartAt = Date.now();
    this._lockUntilAt = Date.now() + durMs;
    this._lockApproved = false;
    this._persistBreakLock();   // no-op for the brief approve-short lock
    this._showLock(this.getLockState());
  }

  // Durably record an in-force break lock by its absolute end time so it can be
  // restored after a reboot. Only the real break persists — the short
  // "get up and check" approve lock is not worth surviving a restart.
  _persistBreakLock() {
    if (this._mode !== 'locked' || this._lockMode !== 'break') return;
    this._persistLock({ mode: 'break', lockUntilAt: this._lockUntilAt });
  }

  _unlock() {
    this._clearLock();
    this._hideLock();
    this._mode = 'idle';
    this._lockMode = null;
    this._lockStartAt = null;
    this._lockUntilAt = null;
    this._lockApproved = false;
    // resume presence countdown fresh
    this._remainingMs = null;
    this._lastTickAt = null;
  }

  _killBeepProc() {
    if (!this._beepProc) return;
    const pid = this._beepProc.pid;
    this._beepProc.removeAllListeners('exit');
    try { this._beepProc.kill(); } catch {}
    this._beepProc = null;
    if (pid) {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, detached: true })
          .on('error', () => {});
      } catch {}
    }
  }
}

function fn(f) { return typeof f === 'function' ? f : () => {}; }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

module.exports = { BreakReminder };
