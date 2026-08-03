// Yesterday's unused time budget is frozen when the new day is created: it must
// survive a restart and must not be rewritten when today's limit changes.
// Run: node test/budget-rollover.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rollover-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
store.load();

const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yKey = store.dateKey(yesterday);

store.setSettings({ timeBudget: { enabled: true, startMinutes: 60, rollover: true } });

// Yesterday: 60m allowance, 20m used → 40m left over.
store.raw().days[yKey] = {
  apps: { Chrome: 1200 }, total: 1200, study: 0, studyApps: {},
  hours: new Array(24).fill(0), firstSeen: yesterday.toISOString(), lastSeen: yesterday.toISOString(),
};

store.addTime('Chrome', 10); // first write of the new day — freezes the carry-over
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 40 * 60, '40m carried into today');
assert.strictEqual(store.raw().budgetRollover.forDate, store.dateKey(), 'frozen for today');

// Lowering today's limit must not retroactively shrink yesterday's leftover.
store.setSettings({ timeBudget: { enabled: true, startMinutes: 10, rollover: true } });
let s = store.getTimeBudgetStatus();
assert.strictEqual(s.startSeconds, 10 * 60, 'the limit follows the setting');
assert.strictEqual(s.rolloverSeconds, 40 * 60, 'carry-over stays frozen');
assert.strictEqual(s.budgetSeconds, 10 * 60 + 40 * 60, 'budget = limit + carry-over');

// And it survives a restart.
store.flush();
store.load();
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 40 * 60, 'carry-over reloaded from disk');

// Turning rollover off drops it immediately.
store.setSettings({ timeBudget: { enabled: true, startMinutes: 10, rollover: false } });
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 0, 'no carry-over when rollover is off');

console.log('budget-rollover: OK');
