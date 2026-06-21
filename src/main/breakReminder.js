const { spawn } = require('child_process');

const PENALTY_FLOOR_MS = 60 * 1000;     // never shorten the next check below 1 minute
const PENALTY_FLOOR_DEV_MS = 3 * 1000;  // ...except in dev mode, where 3s is fine
const PENALTY_MAX_SKIPS = 4;            // cap the speed-up at 2^4 = 16x faster
const BREAK_BASE_MIN = 5;          // suggested break length with no penalty
const BREAK_PENALTY_STEP_MIN = 5;  // extra suggested break minutes added per skipped break
const BREAK_MIN_MS = 5 * 60 * 1000;   // minimum time before next timer starts after "break"
const BREAK_MIN_DEV_MS = 15 * 1000;   // same, in dev mode
const AWAY_RESET_MS = 5 * 60 * 1000;  // away this long → the presence timer resets to full

class BreakReminder {
  constructor({ getSettings, powerMonitor, onPrompt }) {
    this._getSettings = getSettings;
    this._pm = powerMonitor;
    this._onPrompt = typeof onPrompt === 'function' ? onPrompt : () => {};
    this._tickTimer = null;
    this._guardTimer = null;
    this._beepProc = null;
    this._isBeeping = false;
    this._nextCheckAt = null;
    this._remainingMs = null;     // ms left on the presence timer (null = not started yet)
    this._lastTickAt = null;      // timestamp of the previous tick, for measuring elapsed time
    this._awayAt = null;          // when the user went idle (estimated)
    this._skipCount = 0;          // consecutive "no energy" skips since the last real break
    this._owedExtraMin = 0;       // extra break minutes owed because of skips
    this._breakEndAt = null;      // earliest time the presence timer may restart after a "break"
  }

  start() {
    this._startTracking();
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._guardTimer) { clearInterval(this._guardTimer); this._guardTimer = null; }
    this._killBeepProc();
    this._isBeeping = false;
    this._nextCheckAt = null;
    this._remainingMs = null;
    this._lastTickAt = null;
    this._awayAt = null;
    this._breakEndAt = null;
    // penalty state (skipCount / owedExtraMin) is intentionally preserved across
    // restart() so tweaking the alarm sliders doesn't wipe an outstanding debt.
  }

  restart() {
    this.stop();
    this.start();
  }

  testBeep() {
    const s = this._getSettings().breakReminder || {};
    const freq = s.beepFrequency || 1000;
    const dur = s.beepDuration || 200;
    const script = `try{[Console]::Beep(${freq},${dur})}catch{}`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    p.on('error', () => {});
  }

  getStatus() {
    return {
      isBeeping: this._isBeeping,
      nextCheckAt: this._nextCheckAt,
      skipCount: this._skipCount,
      owedExtraMinutes: this._owedExtraMin,
      recommendedBreakMinutes: BREAK_BASE_MIN + this._owedExtraMin,
    };
  }

  // Resolve an active alarm from the in-app prompt. choice ∈ 'break' | 'cant' | 'skip'.
  respond(choice) {
    if (!this._isBeeping) return this.getStatus();
    if (choice === 'break') {
      // you're actually leaving — wipe the debt and enforce a minimum break window
      this._skipCount = 0;
      this._owedExtraMin = 0;
      const s = this._getSettings().breakReminder || {};
      this._breakEndAt = Date.now() + (s.devMode ? BREAK_MIN_DEV_MS : BREAK_MIN_MS);
    } else if (choice === 'skip') {
      // no energy — penalty: ring back twice as fast and owe more rest next time
      this._skipCount = Math.min(this._skipCount + 1, PENALTY_MAX_SKIPS);
      this._owedExtraMin += BREAK_PENALTY_STEP_MIN;
    }
    // 'cant' — snooze with no penalty: leave skipCount / owedExtraMin untouched
    this._stopBeeping();
    return this.getStatus();
  }

  _startTracking() {
    const s = this._getSettings().breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; this._remainingMs = null; return; }
    if (this._tickTimer) return;
    this._remainingMs = null;
    this._lastTickAt = null;
    this._tickTimer = setInterval(() => this._onTick(), 1000);
  }

  // Base interval before any penalty, in ms. Dev mode uses a seconds-based value.
  _baseIntervalMs() {
    const s = this._getSettings().breakReminder || {};
    if (s.devMode) return Math.max(1, s.checkIntervalSeconds || 10) * 1000;
    return (s.checkIntervalMinutes || 60) * 60 * 1000;
  }

  // Next check interval in ms, shortened by 2^skipCount for skipped breaks.
  _effectiveIntervalMs() {
    const s = this._getSettings().breakReminder || {};
    const n = Math.min(this._skipCount, PENALTY_MAX_SKIPS);
    const floor = s.devMode ? PENALTY_FLOOR_DEV_MS : PENALTY_FLOOR_MS;
    return Math.max(floor, Math.round(this._baseIntervalMs() / Math.pow(2, n)));
  }

  // The timer model, in three rules:
  //   1. While you're at the computer, the timer counts down.
  //   2. The moment you leave, it pauses (frozen at whatever was left).
  //   3. If you're away 5+ minutes, it resets to full for when you return.
  // When the timer hits 0 the alarm fires (unchanged).
  _onTick() {
    if (this._isBeeping) return; // guard timer is in charge while beeping
    const settings = this._getSettings();
    const s = settings.breakReminder || {};
    if (!s.enabled) {
      this._nextCheckAt = null; this._remainingMs = null;
      this._lastTickAt = null; this._awayAt = null;
      return;
    }

    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = settings.studyMode ? 0 : this._pm.getSystemIdleTime();
    const now = Date.now();
    const elapsed = this._lastTickAt === null ? 0 : now - this._lastTickAt;
    this._lastTickAt = now;

    if (idleSecs >= idleThreshold) {
      // Rule 2: away — pause the timer.
      if (this._awayAt === null) {
        // First tick we notice the absence. Back-date it to when they actually
        // left and refund the countdown that ran during the idle grace period,
        // so the pause is accurate to the moment they walked away.
        this._awayAt = now - idleSecs * 1000;
        if (this._remainingMs !== null) {
          this._remainingMs = Math.min(this._effectiveIntervalMs(), this._remainingMs + idleSecs * 1000);
          this._nextCheckAt = now + this._remainingMs;
        }
      }
      // Rule 3: away long enough → reset to full for when they return.
      if (now - this._awayAt >= AWAY_RESET_MS) {
        this._remainingMs = null;
        this._nextCheckAt = null;
        this._skipCount = 0;
        this._owedExtraMin = 0;
      }
      return; // frozen while away
    }

    // present at the computer
    this._awayAt = null;

    // After clicking "taking a break", enforce a minimum break window before resuming.
    if (this._breakEndAt !== null) {
      if (now < this._breakEndAt) { this._remainingMs = null; return; }
      this._breakEndAt = null; // minimum time elapsed — allow timer to start
    }

    // Rule 1: count down while present.
    if (this._remainingMs === null) {
      this._remainingMs = this._effectiveIntervalMs(); // fresh start / after a reset
    } else {
      this._remainingMs -= elapsed;
    }

    this._nextCheckAt = now + Math.max(0, this._remainingMs);
    if (this._remainingMs <= 0) {
      this._startBeeping();
    }
  }

  _startBeeping() {
    if (this._isBeeping) return;
    this._isBeeping = true;
    const s = this._getSettings().breakReminder || {};
    const freq = s.beepFrequency || 1000;
    const dur = s.beepDuration || 200;
    const interval = Math.round((s.beepIntervalSeconds || 0.4) * 1000);

    const script = `while($true){try{[Console]::Beep(${freq},${dur})}catch{};Start-Sleep -Milliseconds ${interval}}`;
    this._beepProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      detached: false,
    });
    this._beepProc.on('error', () => {});
    this._beepProc.on('exit', () => { this._beepProc = null; });

    // The alarm now only stops when the user answers the in-app prompt (or disables
    // the feature). The guard just catches the "disabled while ringing" case.
    this._guardTimer = setInterval(() => this._guard(), 1000);

    this._onPrompt(this._promptPayload());
  }

  _promptPayload() {
    return {
      skipCount: this._skipCount,
      owedExtraMinutes: this._owedExtraMin,
      recommendedBreakMinutes: BREAK_BASE_MIN + this._owedExtraMin,
      shortened: this._skipCount > 0,
    };
  }

  _guard() {
    const s = this._getSettings().breakReminder || {};
    if (!s.enabled) this._stopBeeping();
  }

  _stopBeeping() {
    if (this._guardTimer) { clearInterval(this._guardTimer); this._guardTimer = null; }
    this._killBeepProc();
    this._isBeeping = false;
    // restart the presence timer from scratch; the next interval is shortened
    // automatically if skipCount > 0 (see _effectiveIntervalMs).
    this._remainingMs = null;
    this._lastTickAt = null;
    this._nextCheckAt = null;
  }

  _killBeepProc() {
    if (!this._beepProc) return;
    const pid = this._beepProc.pid;
    this._beepProc.removeAllListeners('exit');
    try { this._beepProc.kill(); } catch {}
    this._beepProc = null;
    // taskkill is more reliable than .kill() on Windows for terminating child processes
    if (pid) {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, detached: true })
          .on('error', () => {});
      } catch {}
    }
  }
}

module.exports = { BreakReminder };
