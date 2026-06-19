const { spawn } = require('child_process');

const PENALTY_FLOOR_MS = 60 * 1000;     // never shorten the next check below 1 minute
const PENALTY_FLOOR_DEV_MS = 3 * 1000;  // ...except in dev mode, where 3s is fine
const PENALTY_MAX_SKIPS = 4;            // cap the speed-up at 2^4 = 16x faster
const BREAK_BASE_MIN = 5;          // suggested break length with no penalty
const BREAK_PENALTY_STEP_MIN = 5;  // extra suggested break minutes added per skipped break

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
    this._activeStartedAt = null; // when the current continuous-presence streak began
    this._awayAt = null;          // when the user went idle (estimated)
    this._skipCount = 0;          // consecutive "no energy" skips since the last real break
    this._owedExtraMin = 0;       // extra break minutes owed because of skips
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
    this._activeStartedAt = null;
    this._awayAt = null;
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
      // you're actually leaving — wipe the debt and start a fresh full interval
      this._skipCount = 0;
      this._owedExtraMin = 0;
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
    if (!s.enabled) { this._nextCheckAt = null; this._activeStartedAt = null; return; }
    if (this._tickTimer) return;
    this._activeStartedAt = null;
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

  _onTick() {
    if (this._isBeeping) return; // guard timer is in charge while beeping
    const settings = this._getSettings();
    const s = settings.breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; this._activeStartedAt = null; this._awayAt = null; return; }

    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = this._pm.getSystemIdleTime();
    const now = Date.now();

    if (idleSecs >= idleThreshold) {
      // away — record when they left (estimated from idleSecs)
      if (this._awayAt === null) {
        this._awayAt = now - idleSecs * 1000;
      }
      // after 10 minutes away, treat it as a real break: reset the streak and clear any debt
      if ((now - this._awayAt) / 1000 >= 600 && this._activeStartedAt !== null) {
        this._activeStartedAt = null;
        this._nextCheckAt = null;
        this._skipCount = 0;
        this._owedExtraMin = 0;
      }
      // freeze — don't advance the timer while away
      return;
    }

    // present at the computer
    if (this._activeStartedAt === null) {
      // fresh start (first run or returned after 10+ min away)
      this._activeStartedAt = now;
    } else if (this._awayAt !== null) {
      // returning from a short absence — shift start forward so absence isn't counted
      this._activeStartedAt += now - this._awayAt;
    }
    this._awayAt = null;

    const targetMs = this._effectiveIntervalMs();
    this._nextCheckAt = this._activeStartedAt + targetMs;
    if (now - this._activeStartedAt >= targetMs) {
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
    // restart the continuous-presence streak from scratch; the next interval is
    // shortened automatically if skipCount > 0 (see _effectiveIntervalMin).
    this._activeStartedAt = null;
    this._nextCheckAt = null;
  }

  _killBeepProc() {
    if (this._beepProc) {
      try { this._beepProc.kill(); } catch {}
      this._beepProc = null;
    }
  }
}

module.exports = { BreakReminder };
