const { spawn } = require('child_process');

class BreakReminder {
  constructor({ getSettings, powerMonitor }) {
    this._getSettings = getSettings;
    this._pm = powerMonitor;
    this._tickTimer = null;
    this._absenceTimer = null;
    this._beepProc = null;
    this._isBeeping = false;
    this._nextCheckAt = null;
    this._activeStartedAt = null; // when the current continuous-presence streak began
  }

  start() {
    this._startTracking();
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._absenceTimer) { clearInterval(this._absenceTimer); this._absenceTimer = null; }
    this._killBeepProc();
    this._isBeeping = false;
    this._nextCheckAt = null;
    this._activeStartedAt = null;
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
    return { isBeeping: this._isBeeping, nextCheckAt: this._nextCheckAt };
  }

  _startTracking() {
    const s = this._getSettings().breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; this._activeStartedAt = null; return; }
    if (this._tickTimer) return;
    this._activeStartedAt = null;
    this._tickTimer = setInterval(() => this._onTick(), 1000);
  }

  _onTick() {
    if (this._isBeeping) return; // absence timer is in charge while beeping
    const settings = this._getSettings();
    const s = settings.breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; this._activeStartedAt = null; return; }

    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = this._pm.getSystemIdleTime();
    const now = Date.now();

    if (idleSecs >= idleThreshold) {
      // away from the computer — reset the continuous-presence streak
      this._activeStartedAt = null;
      this._nextCheckAt = null;
      return;
    }

    // present at the computer
    if (this._activeStartedAt === null) {
      this._activeStartedAt = now;
    }
    const targetMs = (s.checkIntervalMinutes || 60) * 60 * 1000;
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

    this._absenceTimer = setInterval(() => this._checkAbsence(), 1000);
  }

  _checkAbsence() {
    const settings = this._getSettings();
    const s = settings.breakReminder || {};
    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = this._pm.getSystemIdleTime();
    if (idleSecs >= idleThreshold || !s.enabled) {
      this._stopBeeping();
    }
  }

  _stopBeeping() {
    if (this._absenceTimer) { clearInterval(this._absenceTimer); this._absenceTimer = null; }
    this._killBeepProc();
    this._isBeeping = false;
    // you took a break — restart the continuous-presence streak from scratch
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
