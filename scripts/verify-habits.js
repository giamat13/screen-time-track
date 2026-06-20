// Exercises the Habits page end-to-end via CDP. Non-destructive: it only ever touches
// its own 'VERIFY_TEMP' habit (looked up by name, never by DOM position) and deletes it
// at the end, so it never disturbs real habits.
const HOST = '127.0.0.1'; // bind address of --remote-debugging-port (localhost may be IPv6)
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
const findCard = `[...document.querySelectorAll('#hab-list .habit-card')].find(c=>c.querySelector('.habit-name').textContent==='VERIFY_TEMP')`;

async function main() {
  const list = await (await fetch(`http://${HOST}:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // create a count habit (Times / per day / target 3) through the form
  const created = await evaluate(ws, 10, `(async () => {
    document.querySelector('[data-page=habits]').click();
    await new Promise(r => setTimeout(r, 250));
    document.querySelector('#hab-add-btn').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#hab-name').value = 'VERIFY_TEMP';
    const t = document.querySelector('#hab-target'); t.value = 3; t.dispatchEvent(new Event('input'));
    document.querySelector('#hab-save').click();
    await new Promise(r => setTimeout(r, 350));
    const card = ${findCard};
    return JSON.stringify({
      pageVisible: !document.querySelector('#page-habits').classList.contains('hidden'),
      name: card && card.querySelector('.habit-name').textContent,
      freq: card && card.querySelector('.freq-tag').textContent,
      ring: card && card.querySelector('.ring-inner').textContent.trim()
    });
  })()`, true);
  console.log('CREATE:', val(created));

  // complete it (3 quick logs) -> done check + level/xp update
  const done = await evaluate(ws, 11, `(async () => {
    for (let i = 0; i < 3; i++) { ${findCard}.querySelector('.hab-log').click(); await new Promise(r => setTimeout(r, 250)); }
    const card = ${findCard};
    return JSON.stringify({
      isDone: card.classList.contains('done'),
      ring: card.querySelector('.ring-inner').textContent.trim(),
      xp: card.querySelector('.xp-text').textContent.trim(),
      history: card.querySelectorAll('.hh-cell').length
    });
  })()`, true);
  console.log('AFTER COMPLETE:', val(done));

  // backdate an entry to yesterday via the custom-log panel
  const backdated = await evaluate(ws, 12, `(async () => {
    const card = ${findCard};
    card.querySelector('.hab-more').click();
    await new Promise(r => setTimeout(r, 120));
    const c = ${findCard};
    const panelOpen = !c.querySelector('.hab-log-panel').classList.contains('hidden');
    const d = new Date(); d.setDate(d.getDate() - 1);
    const yk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    c.querySelector('.hlp-date').value = yk; c.querySelector('.hlp-time').value = '09:30';
    c.querySelector('.hlp-add').click();
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify({ panelOpen, xp: ${findCard}.querySelector('.xp-text').textContent.trim() });
  })()`, true);
  console.log('AFTER BACKDATE:', val(backdated));

  // clean up: delete only VERIFY_TEMP
  await evaluate(ws, 13, `(async () => {
    const hs = await window.api.getHabits();
    const t = hs.find(h => h.name === 'VERIFY_TEMP');
    if (t) await window.api.deleteHabit(t.id);
    return true;
  })()`, true);

  ws.close();
}
main().catch((e) => { console.error('verify-habits failed:', e.message); process.exit(1); });
