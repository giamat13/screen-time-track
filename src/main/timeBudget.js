// Daily screen-time budget lock. Start the day with the daily limit
// (store.globalLimit — the same one the goal streak checks); logging a habit that has a time reward
// (habit.timeReward) tops it up for the rest of the day. Exceeding the budget
// locks the machine via the same fullscreen kiosk window the break-reminder
// lock uses, instead of just failing the day's streak. Driven by an external
// .check() call (main.js calls it on every tracker tick) rather than its own
// timer, since the budget only needs to be re-evaluated when usage changes.
// Dev-release doesn't change usage or the budget — without a grace period the
// very next check() (a tracker tick away) would see the same over-budget
// status and re-lock immediately, making "release the computer" useless for
// anything but a single tick. This mirrors how breakReminder's own unlock
// resets its presence timer to give genuine relief instead of an instant re-fire.
const RELEASE_GRACE_MS = 60 * 1000;

// Crossing the budget (or already being over it the moment tracking resumes —
// e.g. the machine was just turned on, or the feature was just enabled mid-day)
// must never lock instantly with no notice. A short warning window with a
// notification runs first; the lock only actually engages once that elapses
// with usage still over budget.
const WARNING_MS = 60 * 1000;

// How long the budget lock stays off after an urgent release (see urgentRelease).
const URGENT_GRACE_MS = 30 * 60 * 1000;

class TimeBudget {
  constructor({ isDev, getSettings, store, showLock, updateLock, hideLock, notify, logger }) {
    this._isDev = !!isDev;
    this._getSettings = getSettings;
    this._store = store;
    this._showLock = fn(showLock);
    this._updateLock = fn(updateLock);
    this._hideLock = fn(hideLock);
    this._notify = fn(notify);
    this._log = logger || { info() {}, warn() {}, error() {} };
    this._locked = false;
    this._releasedUntil = 0; // epoch ms; suppresses re-locking for RELEASE_GRACE_MS after a dev release
    this._warningUntil = 0;  // epoch ms; while in the future, we're in the pre-lock warning window
    this._warned = false;    // whether the warning notification for the current episode already fired
  }

  _cfg() { return (this._getSettings() || {}).timeBudget || {}; }

  isLocked() { return this._locked; }

  // Call this whenever usage might have changed (tracker tick, after logging a
  // habit). Locks/unlocks/updates the on-screen state as needed.
  check() {
    const settings = this._getSettings() || {};
    if (settings.studyMode) {
      this._clearWarning();
      if (this._locked) this._unlock();
      return;
    }
    if (!this._cfg().enabled) {
      this._clearWarning();
      if (this._locked) this._unlock();
      return;
    }
    if (Date.now() < this._releasedUntil) {
      this._clearWarning();
      if (this._locked) this._unlock();
      return;
    }
    const status = this._store.getTimeBudgetStatus();
    const over = status.usedSeconds > status.budgetSeconds;

    if (this._locked) {
      if (!over) { this._unlock(); return; }
      this._updateLock(this._state(status));
      return;
    }

    if (!over) { this._clearWarning(); return; }

    // Over budget but not locked yet — warn first instead of locking outright,
    // so opening the computer already over budget (or crossing it just now)
    // always gives a heads-up before the machine actually locks.
    const now = Date.now();
    if (!this._warningUntil) this._warningUntil = now + WARNING_MS;
    if (now < this._warningUntil) {
      if (!this._warned) {
        this._warned = true;
        this._notify('נגמר תקציב הזמן', 'המחשב ננעל בעוד דקה. השלימו הרגל עם בונוס זמן כדי לקבל עוד.');
      }
      return;
    }

    this._clearWarning();
    this._locked = true;
    this._log.warn('timeBudget.lock', {
      usedSeconds: status.usedSeconds, budgetSeconds: status.budgetSeconds,
      startMinutes: status.startMinutes, earnedSeconds: status.earnedSeconds,
    });
    this._showLock(this._state(status));
  }

  _clearWarning() { this._warningUntil = 0; this._warned = false; }

  // Panic escape — dev-mode only, exactly like breakReminder.release(), so a
  // test run never traps the developer.
  release() {
    if (!this._isDev) return this.getLockState();
    this._releasedUntil = Date.now() + RELEASE_GRACE_MS;
    this._unlock();
    return { locked: false };
  }

  // Emergency release from the lock screen. Unlike release() this is not
  // dev-only — the accountability is the Telegram ping main.js sends. The grace
  // has to be long enough to actually do the urgent thing, or the lock is back
  // a tracker tick later and the button was a lie.
  urgentRelease() {
    this._releasedUntil = Date.now() + URGENT_GRACE_MS;
    this._log.warn('timeBudget.urgent_release', { graceMinutes: URGENT_GRACE_MS / 60000 });
    this._unlock();
    return { locked: false };
  }

  getLockState() {
    if (!this._locked) return { locked: false };
    return this._state(this._store.getTimeBudgetStatus());
  }

  // Lock-screen "I did a habit" action: log it, then re-check — if the top-up
  // brings usage back under budget this unlocks immediately.
  logHabitAndCheck(habitId, amount = 1) {
    if (!this._locked) return this.getLockState();
    this._store.logHabit(habitId, this._store.clampLogAmount(amount));
    this.check();
    return this.getLockState();
  }

  _unlock() {
    this._locked = false;
    this._clearWarning();
    this._hideLock();
  }

  _state(status) {
    const habits = (this._store.getHabits() || [])
      .filter((h) => (h.timeReward || 0) > 0)
      .map((h) => ({ id: h.id, name: h.name, emoji: h.emoji, timeReward: h.timeReward, unit: h.unit, customUnit: h.customUnit }));
    return {
      locked: true,
      mode: 'budget',
      overSeconds: Math.max(0, status.usedSeconds - status.budgetSeconds),
      usedSeconds: status.usedSeconds,
      budgetSeconds: status.budgetSeconds,
      isDev: this._isDev,
      habits,
    };
  }
}

function fn(f) { return typeof f === 'function' ? f : () => {}; }

module.exports = { TimeBudget };
