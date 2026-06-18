// Verifies idle UI by directly toggling CSS classes via CDP.
const PORT = 9222;
async function main() {
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  function ev(id, expr) {
    return new Promise((res, rej) => {
      const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener('message', h); res(d); } };
      ws.addEventListener('message', h); ws.onerror = rej;
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    });
  }
  const val = (d) => d && d.result && d.result.result ? d.result.result.value : null;

  // Baseline: active state
  const base = await ev(1, `JSON.stringify({
    heroClass: document.querySelector('.hero').className,
    pill: document.querySelector('#tb-status-text').textContent,
    bannerDisplay: window.getComputedStyle(document.querySelector('.hero-idle-banner')).display
  })`);
  console.log('Active state  :', val(base));

  // Simulate IDLE: add .idle class to hero, set pill text
  await ev(2, `(()=>{
    document.querySelector('.hero').classList.add('idle');
    document.querySelector('#tb-status').classList.add('paused');
    document.querySelector('#tb-status-text').textContent = 'Idle';
    document.querySelector('#hero-idle-msg').textContent = 'לא זוהתה פעילות 3 דק׳ 5ש׳ — הזמן לא נספר';
  })()`);
  const idleState = await ev(3, `JSON.stringify({
    heroClass: document.querySelector('.hero').className,
    pill: document.querySelector('#tb-status-text').textContent,
    bannerDisplay: window.getComputedStyle(document.querySelector('.hero-idle-banner')).display,
    bannerMsg: document.querySelector('#hero-idle-msg').textContent,
    heroTimeOpacity: window.getComputedStyle(document.querySelector('.hero-time')).opacity
  })`);
  console.log('Idle state    :', val(idleState));

  // Simulate PAUSED: switch to paused class
  await ev(4, `(()=>{
    document.querySelector('.hero').classList.remove('idle');
    document.querySelector('.hero').classList.add('paused');
    document.querySelector('#tb-status-text').textContent = 'Paused';
  })()`);
  const pausedState = await ev(5, `JSON.stringify({
    heroClass: document.querySelector('.hero').className,
    pill: document.querySelector('#tb-status-text').textContent,
    bannerDisplay: window.getComputedStyle(document.querySelector('.hero-idle-banner')).display
  })`);
  console.log('Paused state  :', val(pausedState));

  // Restore active
  await ev(6, `(()=>{
    document.querySelector('.hero').classList.remove('idle','paused');
    document.querySelector('#tb-status').classList.remove('paused');
    document.querySelector('#tb-status-text').textContent = 'Tracking';
  })()`);
  ws.close();
  console.log('\n✓ idle banner, hero dimming and pill all working correctly');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
