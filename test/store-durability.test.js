// Regression check for the 2026-07-27 data loss: the data file and its backup were
// both found at exactly their normal length (110406 bytes) but filled entirely with
// 0x00. That is what NTFS returns when a file's metadata (its new length) reaches
// the disk but its data never leaves the page cache — i.e. writeFileSync without an
// fsync, followed by an unclean shutdown. Three wipes, three unclean shutdowns.
//
// Run: node test/store-durability.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-durability-'));
const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'st-docs-'));

// store.js/log.js only need electron for app.getPath().
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: (k) => (k === 'documents' ? documents : userData) } };
  }
  return realLoad.call(this, request, ...rest);
};

// --- 1. every durable write is actually fsync'd ---------------------------------
// The bug was invisible in the old code because writeFileSync "succeeds" the moment
// the bytes are in the cache. Count fsyncs to prove we no longer trust that.
const realFsync = fs.fsyncSync;
let fsyncs = 0;
fs.fsyncSync = function (fd) { fsyncs++; return realFsync.call(fs, fd); };

const store = require('../src/main/store.js');
const DATA = path.join(userData, 'screen-time-data.json');
const BAK = DATA + '.bak';

store.load();
store.addTime('Chrome', 120);
fsyncs = 0;
store.flush();

assert.ok(fsyncs >= 2,
  `flush must fsync the main file and the backup, saw ${fsyncs} fsync(s) — without this an ` +
  'unclean shutdown replays a correctly-sized file full of zeros');
assert.strictEqual(JSON.parse(fs.readFileSync(DATA, 'utf8')).days[store.dateKey()].apps.Chrome, 120);
assert.strictEqual(fs.readFileSync(BAK, 'utf8'), fs.readFileSync(DATA, 'utf8'), 'backup written from the same state');

// No temp file left behind — a stray .tmp means the rename never happened.
assert.ok(!fs.existsSync(DATA + '.tmp'), 'temp file must be renamed away');

// --- 2. a zeroed pair is recognised and recovered from a dated snapshot ----------
// This is the exact on-disk state found after the power loss. Previously it meant
// read-only mode and a manual restore; now the snapshot chain carries it.
const snapDir = path.join(userData, 'backups');
const snaps = fs.readdirSync(snapDir).filter((f) => f.endsWith('.json'));
assert.strictEqual(snaps.length, 1, 'flush wrote a dated snapshot');

const zeroed = Buffer.alloc(fs.statSync(DATA).size, 0);
fs.writeFileSync(DATA, zeroed);
fs.writeFileSync(BAK, zeroed);

delete require.cache[require.resolve('../src/main/store.js')];
const store2 = require('../src/main/store.js');
store2.load();

assert.strictEqual(store2.isReadOnly(), false,
  'a good snapshot exists — the app must recover from it, not go read-only');
assert.strictEqual(store2.raw().days[store2.dateKey()].apps.Chrome, 120,
  'recovered the real usage from the dated snapshot');

// The zeroed originals are evidence; they must be kept, not silently overwritten.
const corrupt = fs.readdirSync(path.join(userData, 'corrupt'));
assert.strictEqual(corrupt.length, 2, 'both zeroed copies quarantined for post-mortem');
assert.ok(corrupt.every((f) => fs.readFileSync(path.join(userData, 'corrupt', f)).every((b) => b === 0)),
  'quarantined bytes preserved verbatim');

// Recovery must heal the live files on the next save.
store2.flush();
assert.strictEqual(JSON.parse(fs.readFileSync(DATA, 'utf8')).days[store2.dateKey()].apps.Chrome, 120,
  'main file rewritten from the recovered state');

// --- 3. nothing readable anywhere => still refuse to write -----------------------
// The recovery chain must not become a way to launder empty defaults onto disk.
fs.writeFileSync(DATA, zeroed);
fs.writeFileSync(BAK, zeroed);
for (const f of fs.readdirSync(snapDir)) {
  if (f.endsWith('.json')) fs.writeFileSync(path.join(snapDir, f), zeroed);
}
for (const dir of [path.join(documents, 'ScreenTime Backups')]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.writeFileSync(path.join(dir, f), zeroed);
  }
}
delete require.cache[require.resolve('../src/main/store.js')];
const store3 = require('../src/main/store.js');
store3.load();
assert.strictEqual(store3.isReadOnly(), true, 'no readable copy anywhere => read-only');
store3.addTime('Chrome', 60);
store3.flush();
assert.ok(fs.readFileSync(DATA).every((b) => b === 0), 'must not overwrite the evidence');

// --- 4. the log itself is durable and says what happened ------------------------
const logDir = path.join(userData, 'logs');
const logFiles = fs.readdirSync(logDir);
assert.strictEqual(logFiles.length, 1, 'one log file per day');
const logText = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8');
assert.ok(/store\.load\.candidate_corrupt.*allZeros=true/.test(logText),
  'the log must name the zeroed-file signature, not just "JSON parse error"');
assert.ok(logText.includes('store.load.RECOVERED_FROM_FALLBACK'),
  'a recovery must be recorded loudly');
assert.ok(logText.includes('store.load.ALL_COPIES_UNREADABLE'),
  'total loss must be recorded');

fs.fsyncSync = realFsync;
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(documents, { recursive: true, force: true });
console.log('OK — writes are fsync-durable, a zeroed pair recovers from a snapshot, and the log explains both');
process.exit(0); // addTime() left a 4s debounced save armed against now-deleted dirs
