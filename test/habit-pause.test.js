// A multi-day pause must survive the day it was set, so it isn't re-armed every
// morning. Run: node test/habit-pause.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-habit-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
store.load();

const key = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return store.dateKey(d);
};

const h = store.addHabit({ name: 'ערבית', freqType: 'daily', unit: 'count', target: 1 });

// Pausing for 7 days covers today and the next six.
store.toggleHabitPause(h.id, 7);
let raw = store.raw().habits.find((x) => x.id === h.id);
assert.strictEqual(raw.pausedPeriods.length, 7, 'seven periods paused');
assert.ok(raw.pausedPeriods.includes(key(0)), 'today paused');
assert.ok(raw.pausedPeriods.includes(key(6)), 'day six still paused — no daily renewal');
assert.ok(!raw.pausedPeriods.includes(key(7)), 'day seven not paused');
assert.strictEqual(store.getHabits().find((x) => x.id === h.id).paused, true);

// Resuming clears the rest of the run, not just today.
store.toggleHabitPause(h.id);
raw = store.raw().habits.find((x) => x.id === h.id);
assert.strictEqual(raw.pausedPeriods.length, 0, 'resume ends the whole pause');
assert.strictEqual(store.getHabits().find((x) => x.id === h.id).paused, false);

// Past pauses are history and must not be rewritten by a later resume.
raw.pausedPeriods = [key(-3), key(0), key(1)];
store.toggleHabitPause(h.id);
raw = store.raw().habits.find((x) => x.id === h.id);
assert.deepStrictEqual(raw.pausedPeriods, [key(-3)], 'only current and future cleared');

// Default is still a single period, so the old one-click behaviour is unchanged.
store.toggleHabitPause(h.id);
raw = store.raw().habits.find((x) => x.id === h.id);
assert.strictEqual(raw.pausedPeriods.filter((k) => k >= key(0)).length, 1, 'default pauses one period');

// Weekly habits step by weeks, not days.
const w = store.addHabit({ name: 'פסנתר', freqType: 'weekly', unit: 'count', target: 1 });
store.toggleHabitPause(w.id, 3);
const wraw = store.raw().habits.find((x) => x.id === w.id);
assert.strictEqual(wraw.pausedPeriods.length, 3, 'three weeks paused');
const gap = (new Date(wraw.pausedPeriods[1]) - new Date(wraw.pausedPeriods[0])) / 86400000;
assert.strictEqual(gap, 7, 'weekly pauses advance a week at a time');

fs.rmSync(userData, { recursive: true, force: true });
console.log('OK — habit pause spans multiple periods and resumes in one click');
