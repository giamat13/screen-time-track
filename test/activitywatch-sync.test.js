// ActivityWatch import: fills only hours Screen Time has no data for, ignores AFK,
// is idempotent, and is strictly read-only toward ActivityWatch (GET only).
// Run: node test/activitywatch-sync.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-aw-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
const aw = require('../src/main/activityWatch.js');
store.load();

// Two days ago, 10:00-11:00 local: 30 min chrome (active), 20 min code (active),
// 10 min chrome while AFK. 12:00 hour: Screen Time already has data -> must be skipped.
const day = new Date(); day.setDate(day.getDate() - 2); day.setHours(0, 0, 0, 0);
const at = (h, m) => new Date(day.getTime() + (h * 60 + m) * 60000).toISOString();
const winEvents = [
  { timestamp: at(10, 0), duration: 1800, data: { app: 'chrome.exe', title: 'x' } },
  { timestamp: at(10, 30), duration: 1200, data: { app: 'Code.exe', title: 'y' } },
  { timestamp: at(10, 50), duration: 600, data: { app: 'chrome.exe', title: 'z' } },
  { timestamp: at(12, 0), duration: 600, data: { app: 'chrome.exe', title: 'z' } },
];
const afkEvents = [
  { timestamp: at(10, 0), duration: 3000, data: { status: 'not-afk' } },
  { timestamp: at(10, 50), duration: 600, data: { status: 'afk' } },
  { timestamp: at(12, 0), duration: 600, data: { status: 'not-afk' } },
];

// Pre-existing Screen Time data for 12:00 on that day.
const key = store.dateKey(day);
store.importHour(new Date(day.getTime() + 12 * 3600e3), new Map([['Existing', 60]]));

const methods = [];
const server = http.createServer((req, res) => {
  methods.push(req.method);
  const u = req.url.split('?')[0];
  let body = null;
  if (u === '/api/0/info') body = { version: 'test' };
  else if (u === '/api/0/buckets/') body = { 'aw-watcher-window_pc': {}, 'aw-watcher-afk_pc': {} };
  else if (u.includes('aw-watcher-window')) body = winEvents;
  else if (u.includes('aw-watcher-afk')) body = afkEvents;
  if (!body) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    store.setSettings({ activityWatch: { enabled: true, url, lastSync: null } });

    const r = await aw.sync(store);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const d = store.raw().days[key];
    assert.strictEqual(d.hours[10], 3000, 'AFK 10 min excluded: 30+20 min active');
    assert.strictEqual(d.apps['Google Chrome'], 1800);
    assert.strictEqual(d.hours[12], 60, 'hour with existing data untouched');
    assert.strictEqual(d.apps.Chrome, undefined, 'no raw/unmapped name leaked');

    const again = await aw.sync(store);
    assert.strictEqual(again.hoursFilled, 0, 're-sync is a no-op');
    assert.strictEqual(store.raw().days[key].hours[10], 3000, 'no double count');

    assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'), 'ActivityWatch only ever receives GET');

    store.setSettings({ activityWatch: { enabled: true, url: 'http://127.0.0.1:1', lastSync: null } });
    const down = await aw.sync(store);
    assert.deepStrictEqual([down.ok, down.reason], [false, 'not-running'], 'not installed => quiet no-op');

    store.setSettings({ activityWatch: { enabled: true, url: 'http://example.com', lastSync: null } });
    assert.strictEqual((await aw.sync(store)).ok, false, 'non-localhost URL refused');
    console.log('activitywatch-sync: OK');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
  process.exit(process.exitCode || 0);
});
