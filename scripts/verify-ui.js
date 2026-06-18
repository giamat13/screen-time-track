// Connects to the running app via Chrome DevTools Protocol and inspects the
// live DOM to confirm the renderer initialized and populated the dashboard.
const PORT = 9222;

async function main() {
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const expr = `JSON.stringify({
    title: document.title,
    init: !!window.__screenTimeInit,
    apiPresent: !!window.api,
    heroTime: (document.querySelector('#hero-time')||{}).textContent,
    currentApp: (document.querySelector('#hero-current-app')||{}).textContent,
    appsUsed: (document.querySelector('#s-apps')||{}).textContent,
    mostUsed: (document.querySelector('#s-most')||{}).textContent,
    topListItems: document.querySelectorAll('#top-list li').length,
    donutSegments: document.querySelectorAll('#donut circle').length,
    legendRows: document.querySelectorAll('#dist-legend .legend-row').length,
    navItems: document.querySelectorAll('.nav-item').length,
    trackingPill: (document.querySelector('#tb-status-text')||{}).textContent,
    errors: window.__lastError || null
  })`;

  const result = await new Promise((res, rej) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) res(d);
    };
    ws.onerror = rej;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  ws.close();
  if (result.result && result.result.result && result.result.result.value) {
    console.log('UI STATE:', JSON.stringify(JSON.parse(result.result.result.value), null, 2));
  } else {
    console.log('RAW:', JSON.stringify(result, null, 2));
  }
}

main().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
