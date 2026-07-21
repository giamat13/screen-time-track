// Lock-screen renderer. Talks to the main process via the `lock` bridge exposed
// in preload.js. The window itself is made inescapable in main.js (kiosk,
// always-on-top, close/keyboard swallowing); this file only draws the UI.

const el = (id) => document.getElementById(id);
let totalMs = 0;
let lastState = null;
let reasonOpen = false; // "why do you need more time" panel, shown before an approve ping goes out

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function render(state) {
  if (!state || !state.locked) return;
  lastState = state;
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
  const hint = el('approve-hint');
  const reasonPanel = el('approve-reason-panel');

  if (!state.showApprove) {
    reasonOpen = false;
    approve.classList.add('hidden');
    hint.classList.add('hidden');
    reasonPanel.classList.add('hidden');
  } else if (reasonOpen) {
    // mid-tick re-renders (every second) must not clobber the open reason panel
    approve.classList.add('hidden');
    hint.classList.add('hidden');
    reasonPanel.classList.remove('hidden');
  } else {
    approve.classList.remove('hidden');
    reasonPanel.classList.add('hidden');
    if (state.canApproveNow) {
      hint.classList.add('hidden');
    } else {
      hint.textContent = `לחיצה תשלח הודעה למשגיחים ותשחרר אחרי לפחות ${state.minApproveSeconds} שניות מתחילת הנעילה.`;
      hint.classList.remove('hidden');
    }
  }
}

// Approve requires writing why — so watchers see the reason on Telegram
// instead of having to come ask what's going on.
el('approve').addEventListener('click', () => {
  reasonOpen = true;
  el('approve-reason-input').value = '';
  render(lastState);
  el('approve-reason-input').focus();
});

el('approve-reason-back').addEventListener('click', () => {
  reasonOpen = false;
  render(lastState);
});

el('approve-reason-send').addEventListener('click', async () => {
  const input = el('approve-reason-input');
  const reason = input.value.trim();
  if (!reason) { input.reportValidity(); return; }
  el('approve-reason-send').disabled = true;
  const st = await window.lock.approve(reason);
  reasonOpen = false;
  render(st);
});

el('approve-reason-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('approve-reason-send').click();
});

el('release').addEventListener('click', async () => {
  el('release').disabled = true;
  await window.lock.release();
});

// Block context menu / key-based escapes at the renderer level too — except
// inside the reason input, which needs normal typing to work.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  const typingReason = e.target && e.target.id === 'approve-reason-input';
  if (typingReason && !e.altKey && !e.metaKey && e.key !== 'Escape' && e.key !== 'Tab') return;
  // swallow everything else — the window is a dead end by design
  e.preventDefault();
  e.stopPropagation();
}, true);

window.lock.onTick((state) => render(state));

(async () => {
  const st = await window.lock.getState();
  if (st && st.totalMs) totalMs = st.totalMs;
  render(st);
})();
