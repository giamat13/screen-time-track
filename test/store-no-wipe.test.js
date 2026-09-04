// Regression check for the data-loss bug: an unreadable data file used to fall back
// to empty defaults, and the next flush() wrote those defaults over BOTH the main
// file and its backup. Run: node test/store-no-wipe.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-store-test-'));

// store.js only needs electron for app.getPath('userData').
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
const DATA = path.join(userData, 'screen-time-data.json');
const BAK = DATA + '.bak';

const good = JSON.stringify({
  version: 1,
  installedAt: '2026-06-01T00:00:00.000Z',
  days: { '2026-07-20': { apps: { Chrome: 120 }, total: 120, hours: new Array(24).fill(0) } },
  habits: [{ id: 'h1', name: 'קריאה' }],
  settings: {},
});

// --- 1. corrupt main file: recover from the backup, never destroy either copy ----
fs.writeFileSync(DATA, '{"version":1,"days":{ TRUNCATED');
fs.writeFileSync(BAK, good);
store.load();
assert.strictEqual(store.isReadOnly(), false, 'backup was readable — saving should stay on');
assert.strictEqual(Object.keys(store.raw().days).length, 1, 'recovered days from backup');
store.flush();
assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(DATA, 'utf8')).days).length, 1,
  'main file rewritten with the recovered data, not defaults');
assert.strictEqual(JSON.parse(fs.readFileSync(BAK, 'utf8')).habits.length, 1, 'habits survived');

// --- 2. both live copies unreadable: fall back to a dated snapshot ---------------
// DATA_FILE and BACKUP_FILE are written in the same flush from the same state, so
// they die together (they did, on 2026-07-27). The snapshots are the only
// independent generation, so load() reaches for them before giving up.
fs.writeFileSync(DATA, '{ CORRUPT');
fs.writeFileSync(BAK, '{ ALSO CORRUPT');
delete require.cache[require.resolve('../src/main/store.js')];
const store2 = require('../src/main/store.js');
store2.load();
assert.strictEqual(store2.isReadOnly(), false, 'a readable snapshot must be used, not read-only mode');
assert.strictEqual(Object.keys(store2.raw().days).length, 1, 'recovered days from the snapshot');

// --- 2b. nothing readable anywhere: refuse to write, leave the bytes for recovery -
const snapDirs = [path.join(userData, 'backups'), path.join(userData, 'ScreenTime Backups')];
for (const d of snapDirs) fs.rmSync(d, { recursive: true, force: true });
fs.writeFileSync(DATA, '{ CORRUPT');
fs.writeFileSync(BAK, '{ ALSO CORRUPT');
delete require.cache[require.resolve('../src/main/store.js')];
const store2b = require('../src/main/store.js');
store2b.load();
assert.strictEqual(store2b.isReadOnly(), true, 'must go read-only when nothing loaded');
store2b.addTime('Chrome', 60);
store2b.flush();
assert.strictEqual(fs.readFileSync(DATA, 'utf8'), '{ CORRUPT', 'main file must be untouched');
assert.strictEqual(fs.readFileSync(BAK, 'utf8'), '{ ALSO CORRUPT', 'backup must be untouched');

// --- 3. a dated snapshot exists after a normal save ------------------------------
fs.writeFileSync(DATA, good);
fs.rmSync(BAK, { force: true });
delete require.cache[require.resolve('../src/main/store.js')];
const store3 = require('../src/main/store.js');
store3.load();
store3.flush();
// .json only — the dir also holds a logs/ copy of the forensic log.
const snaps = fs.readdirSync(path.join(userData, 'backups')).filter((f) => f.endsWith('.json'));
assert.strictEqual(snaps.length, 1, 'one dated snapshot written');
assert.strictEqual(Object.keys(JSON.parse(
  fs.readFileSync(path.join(userData, 'backups', snaps[0]), 'utf8')).days).length, 1,
  'snapshot holds the real data');

// --- 4. main file missing but backup present: load the backup, do not reset ------
fs.rmSync(DATA);
fs.writeFileSync(BAK, good);
delete require.cache[require.resolve('../src/main/store.js')];
const store4 = require('../src/main/store.js');
store4.load();
assert.strictEqual(store4.isReadOnly(), false);
assert.strictEqual(Object.keys(store4.raw().days).length, 1, 'loaded from backup');

// --- 5. another live instance owns the data: refuse to write over it ---------------
// This is the two-instances-one-file case: the installed app and a repo-launched app
// share a userData dir, and the one holding empty defaults used to win.
fs.writeFileSync(DATA, good);
fs.writeFileSync(BAK, good);
fs.writeFileSync(path.join(userData, 'owner.json'),
  JSON.stringify({ pid: process.pid + 100000, exe: 'other.exe', ts: Date.now() }));
// A pid that high is very unlikely to exist; if it does, the check below is skipped.
const otherAlive = (() => { try { process.kill(process.pid + 100000, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
if (!otherAlive) {
  // Dead owner => stale claim => we may take over.
  delete require.cache[require.resolve('../src/main/store.js')];
  const store5 = require('../src/main/store.js');
  store5.load();
  assert.strictEqual(store5.isReadOnly(), false, 'a dead owner must not block saving');
}
// A live owner (this very process, seen from a "different" pid) must block writes.
fs.writeFileSync(path.join(userData, 'owner.json'),
  JSON.stringify({ pid: process.pid, exe: 'other.exe', ts: Date.now() }));
delete require.cache[require.resolve('../src/main/store.js')];
const store6 = require('../src/main/store.js');
// Pretend we are a different process so our own pid reads as a foreign live owner.
const realPid = process.pid;
Object.defineProperty(process, 'pid', { value: realPid + 1, configurable: true });
store6.load();
assert.strictEqual(store6.isReadOnly(), true, 'a live foreign owner must block saving');
fs.writeFileSync(DATA, 'UNTOUCHED');
store6.addTime('Chrome', 60);
store6.flush();
assert.strictEqual(fs.readFileSync(DATA, 'utf8'), 'UNTOUCHED',
  'must not write while another instance owns the data');
Object.defineProperty(process, 'pid', { value: realPid, configurable: true });

fs.rmSync(userData, { recursive: true, force: true });
console.log('OK — store never overwrites data it failed to read, and never clobbers a live instance');
