// Fractional habit logs (0.25, 0.5 …) must be stored as typed, must not drift
// when summed, and must scale the time reward. Run: node test/habit-fraction.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-frac-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
store.load();
const get = (id) => store.getHabits().find((x) => x.id === id);

// 40 min of screen time per unit logged.
const h = store.addHabit({ name: 'Read', freqType: 'daily', unit: 'count', target: 1, timeReward: 40 });

store.logHabit(h.id, 0.25);
assert.strictEqual(get(h.id).periodCount, 0.25, 'quarter unit logged as 0.25');
assert.strictEqual(store.timeRewardMinutesFor({ timeReward: 40 }, 0.25), 10, 'reward scales: 40m × 0.25 = 10m');

// Binary-fraction drift: 0.25 + 0.7 + 0.1 is 1.0499999999999998 in raw floats.
store.logHabit(h.id, 0.7);
store.logHabit(h.id, 0.1);
assert.strictEqual(get(h.id).periodCount, 1.05, 'day total does not drift');

// Reward feeds the time budget: (0.25 + 0.7 + 0.1) × 40m = 42m.
store.setSettings({ timeBudget: { enabled: true, startMinutes: 60, rollover: false } });
assert.strictEqual(store.getTimeBudgetStatus().earnedSeconds, 42 * 60, 'budget earns the fractional reward');

// Undo peels a fraction off, not a whole unit.
store.logHabit(h.id, -0.05);
assert.strictEqual(get(h.id).periodCount, 1, 'fractional undo');

console.log('habit-fraction: OK');
