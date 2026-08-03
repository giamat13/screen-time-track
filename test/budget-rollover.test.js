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

// One daily limit drives both the goal streak and the lock.
store.setSettings({ timeBudget: { enabled: true, rollover: true } });
store.setGlobalLimit(60 * 60);
assert.strictEqual(store.getTimeBudgetStatus().startSeconds, 60 * 60, 'the lock uses the daily limit');

// Yesterday: 60m allowance, 20m used → 40m left over.
store.raw().days[yKey] = {
  apps: { Chrome: 1200 }, total: 1200, study: 0, studyApps: {},
  hours: new Array(24).fill(0), firstSeen: yesterday.toISOString(), lastSeen: yesterday.toISOString(),
};

store.addTime('Chrome', 10); // first write of the new day — freezes the carry-over
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 40 * 60, '40m carried into today');
assert.strictEqual(store.raw().budgetRollover.forDate, store.dateKey(), 'frozen for today');

// Lowering today's limit must not retroactively shrink yesterday's leftover.
store.setGlobalLimit(10 * 60);
let s = store.getTimeBudgetStatus();
assert.strictEqual(s.startSeconds, 10 * 60, 'the limit follows the setting');
assert.strictEqual(s.rolloverSeconds, 40 * 60, 'carry-over stays frozen');
assert.strictEqual(s.budgetSeconds, 10 * 60 + 40 * 60, 'budget = limit + carry-over');

// And it survives a restart.
store.flush();
store.load();
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 40 * 60, 'carry-over reloaded from disk');

// Turning rollover off drops it immediately.
store.setSettings({ timeBudget: { enabled: true, rollover: false } });
assert.strictEqual(store.getTimeBudgetStatus().rolloverSeconds, 0, 'no carry-over when rollover is off');

// No daily limit means nothing to enforce — the lock cannot arm on a 0 allowance.
store.setGlobalLimit(0);
assert.strictEqual(store.getTimeBudgetStatus().enabled, false, 'lock stays off without a daily limit');

console.log('budget-rollover: OK');
