const { spawn } = require('child_process');

class BreakReminder {
  constructor({ getSettings, powerMonitor }) {
    this._getSettings = getSettings;
    this._pm = powerMonitor;
    this._checkTimer = null;
    this._absenceTimer = null;
    this._beepProc = null;
    this._isBeeping = false;
    this._nextCheckAt = null;
  }

  start() {
    this._scheduleCheck();
  }

  stop() {
    if (this._checkTimer) { clearTimeout(this._checkTimer); this._checkTimer = null; }
    if (this._absenceTimer) { clearInterval(this._absenceTimer); this._absenceTimer = null; }
    this._killBeepProc();
    this._isBeeping = false;
    this._nextCheckAt = null;
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

  _scheduleCheck() {
    const s = this._getSettings().breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; return; }
    const ms = (s.checkIntervalMinutes || 75) * 60 * 1000;
    this._nextCheckAt = Date.now() + ms;
    this._checkTimer = setTimeout(() => this._onCheck(), ms);
  }

  _onCheck() {
    this._checkTimer = null;
    const settings = this._getSettings();
    const s = settings.breakReminder || {};
    if (!s.enabled) { this._nextCheckAt = null; return; }

    const idleThreshold = settings.idleThreshold || 120;
    const idleSecs = this._pm.getSystemIdleTime();
    if (idleSecs < idleThreshold) {
      this._startBeeping();
    } else {
      this._scheduleCheck();
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
    this._scheduleCheck();
  }

  _killBeepProc() {
    if (this._beepProc) {
      try { this._beepProc.kill(); } catch {}
      this._beepProc = null;
    }
  }
}

module.exports = { BreakReminder };
