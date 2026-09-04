// Study Mode should suppress break/time-budget locks entirely.
// Run: node test/study-mode-locks.test.js
const assert = require('assert');

const { BreakReminder } = require('../src/main/breakReminder.js');
const { TimeBudget } = require('../src/main/timeBudget.js');

function makeBreakReminder() {
  const calls = [];
  const reminder = new BreakReminder({
    isDev: false,
    getSettings: () => ({ studyMode: true, breakReminder: { enabled: true, breakLockMinutes: 5, approveShortLockSeconds: 10 } }),
    getInCall: () => false,
    powerMonitor: { getSystemIdleTime: () => 0 },
    onPrompt: () => {},
    showLock: () => calls.push('showLock'),
    updateLock: () => calls.push('updateLock'),
    hideLock: () => calls.push('hideLock'),
    sendTelegram: () => {},
    notify: () => {},
    persistLock: () => {},
    clearLock: () => {},
    store: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  reminder._startBeeping = () => calls.push('beep');
  return { reminder, calls };
}

function makeTimeBudget() {
  const calls = [];
  const store = {
    getTimeBudgetStatus: () => ({ usedSeconds: 1200, budgetSeconds: 600, startSeconds: 600, earnedSeconds: 0, rolloverSeconds: 0 }),
    getHabits: () => [],
  };
  const budget = new TimeBudget({
    isDev: false,
    getSettings: () => ({ studyMode: true, timeBudget: { enabled: true } }),
    store,
    showLock: () => calls.push('showLock'),
    updateLock: () => calls.push('updateLock'),
    hideLock: () => calls.push('hideLock'),
    notify: () => {},
    logger: { info() {}, warn() {}, error() {} },
  });
  return { budget, calls };
}

{
  const { reminder, calls } = makeBreakReminder();
  reminder._remainingMs = 0;
  reminder._lastTickAt = Date.now() - 1000;
  reminder._tickPresence();
  assert.deepStrictEqual(calls, [], 'break reminders should not enter beeping/lock state in study mode');
}

{
  const { reminder, calls } = makeBreakReminder();
  reminder.respond('break');
  assert.strictEqual(reminder.getStatus().isLocked, false, 'taking a break should not lock the computer in study mode');
  assert.deepStrictEqual(calls, [], 'taking a break should not invoke the lock UI in study mode');
}

{
  const { budget, calls } = makeTimeBudget();
  budget.check();
  assert.strictEqual(budget.isLocked(), false, 'time-budget lock should stay disabled in study mode');
  assert.deepStrictEqual(calls, [], 'time-budget should not invoke the lock UI in study mode');
}

console.log('study-mode-locks: OK');
