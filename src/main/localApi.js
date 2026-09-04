// Local loopback HTTP API so other apps on this machine can read Screen Time's
// data — in particular, whether the user is present right now. Binds to
// 127.0.0.1 only; nothing leaves the machine. Modeled on browserBridge.js.
const http = require('http');
const log = require('./log');

const HOST = '127.0.0.1';
const PORT = 47834;

let server = null;

// getStatus/getToday: functions returning JSON-serializable data, supplied by main.js.
function start(getStatus, getToday) {
  if (server) return;
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    const url = (req.url || '').split('?')[0];
    let payload;
    if (url === '/status') payload = getStatus();
    else if (url === '/today') payload = getToday();
    else { res.writeHead(404); res.end('{"error":"not found"}'); return; }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(payload));
  });
  server.on('error', (e) => log.error('localApi.server_error', {
    err: e.message, code: e.code, port: PORT,
    note: e.code === 'EADDRINUSE' ? 'another Screen Time instance already holds this port' : undefined,
  }));
  server.listen(PORT, HOST, () => log.info('localApi.listening', { host: HOST, port: PORT }));
}

function stop() {
  if (server) { try { server.close(); } catch (e) { log.warn('localApi.close_failed', { err: e.message }); } server = null; }
}

module.exports = { start, stop, PORT };
