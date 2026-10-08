// Optional import from a locally installed ActivityWatch (https://activitywatch.net).
//
// STRICTLY READ-ONLY toward ActivityWatch: this file only issues HTTP GETs against
// its local REST API (list buckets, read events). It never POSTs, PUTs, DELETEs or
// writes to ActivityWatch's files — all changes land in Screen Time's own store.
//
// What it does: ActivityWatch usually runs 24/7, Screen Time may not have (app was
// closed, crashed, machine booted without it). For each of the last few days it
// finds the *hours in which Screen Time recorded nothing* and fills them in from
// ActivityWatch's active (not-AFK) window time. Hours Screen Time already has data
// for are never touched, so nothing is double-counted and re-running is a no-op.
const http = require('http');
const log = require('./log');
const { friendlyName } = require('./tracker');

const DEFAULT_URL = 'http://127.0.0.1:5600';
const LOOKBACK_DAYS = 7;
const REQUEST_TIMEOUT_MS = 4000;
const HOUR_MS = 3600 * 1000;

// ---- read-only HTTP --------------------------------------------------------
function getJson(baseUrl, pathAndQuery) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathAndQuery, baseUrl); } catch (e) { reject(e); return; }
    // Loopback only: this is a local-machine integration, never reach out further.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      reject(new Error('ActivityWatch URL must be on localhost')); return;
    }
    const req = http.get(u, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---- interval helpers ------------------------------------------------------
// events -> sorted [{start,end,data}] in epoch ms
function toIntervals(events) {
  return (events || [])
    .map((e) => {
      const start = Date.parse(e.timestamp);
      return { start, end: start + (Number(e.duration) || 0) * 1000, data: e.data || {} };
    })
    .filter((i) => isFinite(i.start) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
}

// Total ms of [s,e) covered by the union of `ranges` (sorted, may overlap).
function overlapWith(ranges, s, e) {
  let total = 0, cursor = s;
  for (const r of ranges) {
    if (r.end <= cursor) continue;
    if (r.start >= e) break;
    const a = Math.max(r.start, cursor), b = Math.min(r.end, e);
    if (b > a) { total += b - a; cursor = b; }
  }
  return total;
}

// Active (not-AFK) window time per app, split into hour buckets.
// Returns Map<hourStartMs, Map<appName, seconds>>.
function activeSecondsByHour(windowEvents, afkEvents, fromMs, toMs) {
  const win = toIntervals(windowEvents);
  const notAfk = toIntervals(afkEvents).filter((i) => i.data.status === 'not-afk');
  const out = new Map();
  for (const w of win) {
    const s0 = Math.max(w.start, fromMs), e0 = Math.min(w.end, toMs);
    if (e0 <= s0) continue;
    const appRaw = w.data.app;
    if (!appRaw) continue;
    const app = friendlyName(String(appRaw).replace(/\.exe$/i, ''), '');
    if (!app) continue;
    for (let h = Math.floor(s0 / HOUR_MS) * HOUR_MS; h < e0; h += HOUR_MS) {
      const s = Math.max(s0, h), e = Math.min(e0, h + HOUR_MS);
      const ms = overlapWith(notAfk, s, e);
      if (ms <= 0) continue;
      if (!out.has(h)) out.set(h, new Map());
      const m = out.get(h);
      m.set(app, (m.get(app) || 0) + ms / 1000);
    }
  }
  return out;
}

// ---- sync ------------------------------------------------------------------
async function findBuckets(baseUrl) {
  const buckets = await getJson(baseUrl, '/api/0/buckets/');
  const ids = Object.keys(buckets || {});
  return {
    windowId: ids.find((id) => id.startsWith('aw-watcher-window')) || null,
    afkId: ids.find((id) => id.startsWith('aw-watcher-afk')) || null,
  };
}

async function isInstalled(baseUrl = DEFAULT_URL) {
  try { await getJson(baseUrl, '/api/0/info'); return true; } catch (e) { return false; }
}

// store: the Screen Time store module. Returns a small result object; never throws.
async function sync(store) {
  const cfg = Object.assign({ enabled: true, url: DEFAULT_URL }, store.getSettings().activityWatch);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  const base = cfg.url || DEFAULT_URL;
  try {
    if (!(await isInstalled(base))) return { ok: false, reason: 'not-running' };
    const { windowId, afkId } = await findBuckets(base);
    // Without the AFK watcher we can't tell idle from active — importing would
    // inflate the numbers, so skip rather than guess.
    if (!windowId || !afkId) return { ok: false, reason: 'missing-buckets' };

    // Only completed hours: the current hour belongs to the live tracker.
    const toMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const fromDay = new Date(); fromDay.setHours(0, 0, 0, 0); fromDay.setDate(fromDay.getDate() - LOOKBACK_DAYS);
    const fromMs = fromDay.getTime();
    const q = `?start=${encodeURIComponent(new Date(fromMs).toISOString())}` +
              `&end=${encodeURIComponent(new Date(toMs).toISOString())}&limit=-1`;
    const [winEv, afkEv] = await Promise.all([
      getJson(base, `/api/0/buckets/${encodeURIComponent(windowId)}/events${q}`),
      getJson(base, `/api/0/buckets/${encodeURIComponent(afkId)}/events${q}`),
    ]);

    const byHour = activeSecondsByHour(winEv, afkEv, fromMs, toMs);
    let hoursFilled = 0, seconds = 0;
    for (const [hourMs, apps] of byHour) {
      const added = store.importHour(new Date(hourMs), apps);
      if (added > 0) { hoursFilled++; seconds += added; }
    }
    store.setSettings({ activityWatch: { ...cfg, lastSync: new Date().toISOString() } });
    log.info('activityWatch.sync', { hoursFilled, seconds: Math.round(seconds) });
    return { ok: true, hoursFilled, seconds: Math.round(seconds) };
  } catch (e) {
    log.warn('activityWatch.sync_failed', { err: e.message });
    return { ok: false, reason: 'error', error: e.message };
  }
}

module.exports = { sync, isInstalled, activeSecondsByHour, DEFAULT_URL };
