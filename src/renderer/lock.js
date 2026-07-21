// Lock-screen renderer. Talks to the main process via the `lock` bridge exposed
// in preload.js. The window itself is made inescapable in main.js (kiosk,
// always-on-top, close/keyboard swallowing); this file only draws the UI.

const el = (id) => document.getElementById(id);
let totalMs = 0;

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function render(state) {
  if (!state || !state.locked) return;
  const isBreak = state.mode === 'break';
  el('emoji').textContent = isBreak ? '🔒' : '⏳';
  el('title').textContent = isBreak ? 'זמן להפסקה' : 'קום לרגע לבדוק';
  el('sub').textContent = isBreak
    ? 'קום, מתח את הגוף, ותן לעיניים לנוח. אי אפשר לצאת עד שהזמן נגמר.'
    : 'קום שנייה מהמחשב ותראה אם מישהו צריך אותך.';

  el('count').textContent = fmt(state.remainingMs);
  if (state.totalMs && state.totalMs > totalMs) totalMs = state.totalMs;
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (state.remainingMs / totalMs) * 100)) : 0;
  el('bar').style.width = pct + '%';

  const approve = el('approve');
  approve.classList.toggle('hidden', !state.showApprove);
  const hint = el('approve-hint');
  if (state.showApprove) {
    if (state.canApproveNow) {
      approve.disabled = false;
      hint.classList.add('hidden');
    } else {
      approve.disabled = false; // still clickable — it just shortens the wait to the minimum
      hint.textContent = `לחיצה תשלח הודעה למשגיחים ותשחרר אחרי לפחות ${state.minApproveSeconds} שניות מתחילת הנעילה.`;
      hint.classList.remove('hidden');
    }
  } else {
    hint.classList.add('hidden');
  }

  el('debug').classList.toggle('hidden', !state.showDebug);
}

el('approve').addEventListener('click', async () => {
  el('approve').disabled = true;
  const st = await window.lock.approve();
  render(st);
});

el('debug').addEventListener('click', async () => {
  await window.lock.debugExit();
});

// Block context menu / key-based escapes at the renderer level too.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  // swallow everything except nothing — the window is a dead end by design
  e.preventDefault();
  e.stopPropagation();
}, true);

window.lock.onTick((state) => render(state));

(async () => {
  const st = await window.lock.getState();
  if (st && st.totalMs) totalMs = st.totalMs;
  render(st);
})();
