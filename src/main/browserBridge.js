// Local loopback HTTP server that receives active-tab + media-playback state
// from the Screen Time browser extension. Nothing leaves the machine: the
// server binds to 127.0.0.1 only and just caches the latest report so the
// tracker can attribute time to the real site instead of "Google Chrome".
const http = require('http');
const log = require('./log');

const HOST = '127.0.0.1';
const PORT = 47832;
const STALE_MS = 12000; // state older than this is treated as unknown

let latest = null; // { active, url, title, domain, playing, audible, ts }
let server = null;
let reports = 0;        // how many the extension has sent this run
let badBodies = 0;
let lastDomain = null;

function start() {
  if (server) return;
  server = http.createServer((req, res) => {
    // The extension's service worker has a 127.0.0.1 host permission, but we
    // answer CORS preflights anyway so the POST always goes through.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        data.ts = Date.now();
        latest = data;
        reports++;
        // Only on change, not every report — this fires several times a minute.
        // It is what turns "9h of Chrome" back into which sites that actually was.
        if (data.domain !== lastDomain) {
          log.info('bridge.tab_changed', {
            domain: data.domain, active: data.active, playing: data.playing,
            micGranted: data.micGranted, reports,
          });
          lastDomain = data.domain;
        }
      } catch (e) {
        if (++badBodies <= 5) log.warn('bridge.bad_body', { err: e.message, bytes: body.length });
      }
      res.writeHead(200); res.end('{"ok":true}');
    });
  });
  server.on('error', (e) => log.error('bridge.server_error', {
    err: e.message, code: e.code, port: PORT,
    note: e.code === 'EADDRINUSE' ? 'another Screen Time instance already holds this port' : undefined,
  }));
  server.listen(PORT, HOST, () => log.info('bridge.listening', { host: HOST, port: PORT }));
}

// Latest browser state, or null if we have nothing fresh.
function getState() {
  if (!latest) return null;
  if (Date.now() - latest.ts > STALE_MS) return null;
  return latest;
}

function stop() {
  log.info('bridge.stop', { reports, badBodies });
  if (server) { try { server.close(); } catch (e) { log.warn('bridge.close_failed', { err: e.message }); } server = null; }
}

module.exports = { start, stop, getState, PORT };
