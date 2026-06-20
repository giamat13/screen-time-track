async function main() {
  const list = await (await fetch('http://localhost:9222/json')).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('index.html')) || list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 1;
  const send = (method, params) => new Promise(res => {
    const myId = id++;
    ws.send(JSON.stringify({ id: myId, method, params }));
    const h = m => { const d = JSON.parse(m.data); if (d.id === myId) { ws.removeEventListener('message', h); res(d); } };
    ws.addEventListener('message', h);
  });

  // Check initial state
  const pre = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      activePage: [...document.querySelectorAll('.page')].find(p => !p.classList.contains('hidden'))?.id,
      activeNav: document.querySelector('.nav-item.active')?.dataset?.page,
      navCount: document.querySelectorAll('.nav-item').length,
    })`,
    returnByValue: true
  });
  console.log('Before click:', JSON.parse(pre.result.result.value));

  // Navigate to reminders via direct go() call to avoid click issues
  const navResult = await send('Runtime.evaluate', {
    expression: `(function() {
      const btn = document.querySelector('[data-page="reminders"]');
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    })()`,
    returnByValue: true
  });
  console.log('Nav result:', navResult.result?.result?.value);

  await new Promise(r => setTimeout(r, 800));

  // Check after click
  const post = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      activePage: [...document.querySelectorAll('.page')].find(p => !p.classList.contains('hidden'))?.id,
      activeNav: document.querySelector('.nav-item.active')?.dataset?.page,
      remPageHidden: document.getElementById('page-reminders').classList.contains('hidden'),
      remListItems: document.getElementById('rem-list').children.length,
      remListText: document.getElementById('rem-list').textContent.trim().slice(0, 80),
    })`,
    returnByValue: true
  });
  console.log('After navigation:', JSON.parse(post.result.result.value));

  // Test adding a reminder
  await send('Runtime.evaluate', { expression: 'document.getElementById("rem-add-btn").click()', returnByValue: true });
  await new Promise(r => setTimeout(r, 300));

  await send('Runtime.evaluate', { expression: 'document.getElementById("rem-time").value = "14:30"', returnByValue: true });
  await send('Runtime.evaluate', { expression: 'document.getElementById("rem-message").value = "Test reminder message"', returnByValue: true });
  await send('Runtime.evaluate', { expression: 'document.getElementById("rem-save").click()', returnByValue: true });
  await new Promise(r => setTimeout(r, 600));

  const final = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      remListItems: document.getElementById('rem-list').children.length,
      remListText: document.getElementById('rem-list').textContent.trim().slice(0, 100),
      formHidden: document.getElementById('rem-add-form').classList.contains('hidden'),
    })`,
    returnByValue: true
  });
  console.log('After saving reminder:', JSON.parse(final.result.result.value));

  ws.close();
}

main().catch(e => { console.error('verify failed:', e.message); process.exit(1); });
