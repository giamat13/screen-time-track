// Verifies the Forest tab end-to-end over CDP against a running dev instance
// (launch with --dev --remote-debugging-port=9222 first).
// Non-destructive: only creates/removes a uniquely-named temp task, plus one
// zero-length given-up test session (recorded as species 'oak', 0s focus).
// Run: node scripts/verify-forest.js

const PORT = 9222;
const TEMP_TASK = `CDP-TEST-${Date.now()}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok', name);
  else { failures++; console.error('  FAIL', name, extra ?? ''); }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('renderer page target not found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  function evaluate(expression, awaitPromise = false) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
    return new Promise((res) => pending.set(id, (m) => {
      if (m.result?.exceptionDetails) res({ error: m.result.exceptionDetails.exception?.description || 'eval error' });
      else res({ value: m.result?.result?.value });
    }));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('navigate to Forest tab');
  await evaluate(`document.querySelector('.nav-item[data-page="forest"]').click()`);
  await sleep(600);
  {
    const r = await evaluate(`!document.querySelector('#page-forest').classList.contains('hidden')`);
    check('forest page visible', r.value === true, r.error);
  }

  console.log('plant view');
  {
    let r = await evaluate(`document.querySelectorAll('#forest-species-picker .forest-species').length`);
    check('8 species in picker', r.value === 8, r.value);
    r = await evaluate(`document.querySelectorAll('#forest-species-picker .forest-species.locked').length`);
    check('7 locked initially (or fewer if owned)', r.value <= 7, r.value);
    r = await evaluate(`!!document.querySelector('#forest-preview-tree svg')`);
    check('preview tree SVG rendered', r.value === true);
    r = await evaluate(`document.querySelector('#forest-coins-val').textContent`);
    check('coin counter present', /^\\d+$/.test(r.value), r.value);
  }

  console.log('subtab switching');
  for (const view of ['tasks', 'myforest', 'shop', 'fstats', 'badges', 'plant']) {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="${view}"]').click()`);
    await sleep(150);
    const r = await evaluate(`!document.querySelector('#fview-${view}').classList.contains('hidden')`);
    check(`subtab ${view} shows`, r.value === true);
  }

  console.log('shop');
  {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="shop"]').click()`);
    await sleep(150);
    let r = await evaluate(`document.querySelectorAll('.forest-shop-card').length`);
    check('8 shop cards', r.value === 8, r.value);
    r = await evaluate(`document.querySelectorAll('.forest-shop-btn.selected').length`);
    check('exactly one selected species', r.value === 1, r.value);
  }

  console.log('achievements');
  {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="badges"]').click()`);
    await sleep(150);
    const r = await evaluate(`document.querySelectorAll('.forest-badge').length`);
    check('9 achievement badges', r.value === 9, r.value);
  }

  console.log('tasks: add + delete temp task');
  {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="tasks"]').click()`);
    await sleep(150);
    await evaluate(`
      (async () => {
        document.querySelector('#forest-task-input').value = ${JSON.stringify(TEMP_TASK)};
        document.querySelector('#forest-task-add-btn').click();
      })()`, true);
    await sleep(500);
    let r = await evaluate(`[...document.querySelectorAll('.forest-task .ft-title')].some(e => e.textContent === ${JSON.stringify(TEMP_TASK)})`);
    check('temp task appears', r.value === true);
    // delete ONLY the temp task, located by its unique name
    await evaluate(`
      (async () => {
        const row = [...document.querySelectorAll('.forest-task')].find(e => e.querySelector('.ft-title').textContent === ${JSON.stringify(TEMP_TASK)});
        if (row) row.querySelector('.ft-del').click();
      })()`, true);
    await sleep(500);
    r = await evaluate(`[...document.querySelectorAll('.forest-task .ft-title')].some(e => e.textContent === ${JSON.stringify(TEMP_TASK)})`);
    check('temp task deleted', r.value === false);
  }

  console.log('session flow: plant (stopwatch) -> live view -> give up -> result modal');
  {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="plant"]').click()`);
    await sleep(150);
    await evaluate(`document.querySelector('#forest-mode-stopwatch').click()`);
    await evaluate(`document.querySelector('#forest-plant-btn').click()`, true);
    await sleep(1500);
    let r = await evaluate(`!document.querySelector('#forest-active').classList.contains('hidden')`);
    check('active session view shows', r.value === true);
    r = await evaluate(`!!document.querySelector('#forest-live-tree svg')`);
    check('live tree SVG rendered', r.value === true);
    r = await evaluate(`document.querySelector('#forest-live-timer').textContent`);
    check('live timer counting', /^\\d{2}:\\d{2}$/.test(r.value), r.value);

    // give up (bypass confirm dialog)
    await evaluate(`window.confirm = () => true; document.querySelector('#forest-giveup-btn').click()`, true);
    await sleep(800);
    r = await evaluate(`!document.querySelector('#forest-result-modal').classList.contains('hidden')`);
    check('result modal appears', r.value === true);
    r = await evaluate(`document.querySelector('#forest-result-title').textContent`);
    check('result says gave up', r.value === 'You gave up', r.value);
    await evaluate(`document.querySelector('#forest-result-ok').click()`);
    await sleep(300);
    r = await evaluate(`!document.querySelector('#forest-setup').classList.contains('hidden')`);
    check('back to setup view', r.value === true);
  }

  console.log('my forest shows the given-up tree today');
  {
    await evaluate(`document.querySelector('.forest-subtabs [data-fview="myforest"]').click()`);
    await sleep(300);
    const r = await evaluate(`!!document.querySelector('#forest-diorama svg')`);
    check('diorama tile rendered for today', r.value === true);
  }

  ws.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nall UI checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
