// Doing double the target in one period banks an extra streak freezer.
// Run: node test/habit-freezer-bonus.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-freezer-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
store.load();
const get = (id) => store.getHabits().find((x) => x.id === id);

const h = store.addHabit({ name: 'Pushups', freqType: 'daily', unit: 'count', target: 10 });
const base = get(h.id).freezers;

store.logHabit(h.id, 10); // exactly the target — nothing extra
assert.strictEqual(get(h.id).freezers, base, 'meeting the target alone earns no freezer');

store.logHabit(h.id, 9); // 19 — over, but not double
assert.strictEqual(get(h.id).freezers, base, 'over but under double earns nothing');

store.logHabit(h.id, 1); // 20 — double
assert.strictEqual(get(h.id).freezers, base + 1, 'double the target banks a freezer');

store.logHabit(h.id, 20); // 40 — still one bonus per period, not per extra dose
assert.strictEqual(get(h.id).freezers, base + 1, 'one bonus freezer per period');

// Track-only habits (no target) must not mint a freezer on every second log.
const t = store.addHabit({ name: 'Water', freqType: 'daily', unit: 'count', target: 0 });
const tBase = get(t.id).freezers;
store.logHabit(t.id, 5);
assert.strictEqual(get(t.id).freezers, tBase, 'track-only habits earn no overachievement freezers');

console.log('habit-freezer-bonus: OK');
