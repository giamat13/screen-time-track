// Exercises navigation + the Statistics and App Blocking pages via CDP.
const PORT = 9222;

async function evaluate(ws, id, expression, awaitPromise = false) {
  return new Promise((res, rej) => {
    const handler = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === id) { ws.removeEventListener('message', handler); res(d); }
    };
    ws.addEventListener('message', handler);
    ws.onerror = rej;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
  });
}
const val = (d) => d.result && d.result.result ? d.result.result.value : undefined;

async function main() {
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // Statistics
  const stats = await evaluate(ws, 10, `(async () => {
    document.querySelector('[data-page=statistics]').click();
    await new Promise(r => setTimeout(r, 1600));
    return JSON.stringify({
      visible: !document.querySelector('#page-statistics').classList.contains('hidden'),
      total: document.querySelector('#st-total').textContent,
      dayBars: document.querySelectorAll('#day-bars .bar-col').length,
      breakdownRows: document.querySelectorAll('#app-breakdown .bd-row').length
    });
  })()`, true);
  console.log('STATISTICS:', val(stats));

  // App Blocking (running list uses a PowerShell call -> allow more time)
  const blocking = await evaluate(ws, 11, `(async () => {
    document.querySelector('[data-page=blocking]').click();
    await new Promise(r => setTimeout(r, 3500));
    return JSON.stringify({
      visible: !document.querySelector('#page-blocking').classList.contains('hidden'),
      blockingToggle: document.querySelector('#blocking-toggle').checked,
      runningApps: document.querySelectorAll('#running-list li').length,
      runningSample: Array.from(document.querySelectorAll('#running-list li span')).slice(0,5).map(s=>s.textContent)
    });
  })()`, true);
  console.log('BLOCKING:', val(blocking));

  // Settings reflects stored values
  const settings = await evaluate(ws, 12, `(async () => {
    document.querySelector('[data-page=settings]').click();
    await new Promise(r => setTimeout(r, 400));
    return JSON.stringify({
      tracking: document.querySelector('#set-tracking').checked,
      autoLaunch: document.querySelector('#set-autolaunch').checked,
      idle: document.querySelector('#set-idle').value
    });
  })()`, true);
  console.log('SETTINGS:', val(settings));

  // back to dashboard
  await evaluate(ws, 13, `document.querySelector('[data-page=dashboard]').click(); true`);
  ws.close();
}
main().catch((e) => { console.error('verify-pages failed:', e.message); process.exit(1); });
