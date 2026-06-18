// Standalone check of the browser-bridge plumbing and site labeling, without
// needing Electron. Run: node scripts/verify-bridge.js
const assert = require('assert');
const http = require('http');
const bridge = require('../src/main/browserBridge');
const { siteLabel } = require('../src/main/tracker');

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: bridge.PORT, path: '/state', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  // --- site labeling ---
  assert.strictEqual(siteLabel('www.youtube.com'), 'YouTube');
  assert.strictEqual(siteLabel('m.youtube.com'), 'YouTube');
  assert.strictEqual(siteLabel('github.com'), 'GitHub');
  assert.strictEqual(siteLabel('some-random-site.org'), 'some-random-site.org');
  console.log('PASS  site labeling');

  // --- bridge server ---
  bridge.start();
  assert.strictEqual(bridge.getState(), null, 'should start empty');

  await post({ active: true, domain: 'youtube.com', title: 'Cool video', playing: true, ad: false });
  let s = bridge.getState();
  assert.ok(s && s.active && s.domain === 'youtube.com' && s.playing === true && s.ad === false);
  console.log('PASS  bridge receives YouTube playing state');

  await post({ active: true, domain: 'youtube.com', title: 'Ad', playing: true, ad: true });
  s = bridge.getState();
  assert.ok(s.ad === true, 'ad flag should propagate');
  console.log('PASS  bridge receives ad state');

  bridge.stop();
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
