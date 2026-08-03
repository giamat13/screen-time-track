// Lock-screen renderer. Talks to the main process via the `lock` bridge exposed
// in preload.js. The window itself is made inescapable in main.js (kiosk,
// always-on-top, close/keyboard swallowing); this file only draws the UI.

const el = (id) => document.getElementById(id);
let totalMs = 0;
let lastState = null;
let reasonOpen = false; // "why do you need more time" panel, shown before an approve ping goes out
let urgentOpen = false; // emergency-release panel
let habitSig = null;    // what the habit rows were last built from

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// "I did a habit" panel — shared by every lock mode that has reward habits to
// offer (budget lock always; break/approve-short whenever any habit has a
// timeReward configured). Logs the habit and re-renders with the result: the
// budget lock unlocks once usage is back under budget, a break lock instead
// shaves the habit's timeReward minutes off the remaining countdown.
function unitLabel(h) {
  if (h.unit === 'minutes') return 'דק\'';
  if (h.unit === 'custom' && h.customUnit) return h.customUnit;
  return 'פעמים';
}

function renderHabitPicker(state) {
  const panel = el('budget-habits-panel');
  const list = el('budget-habit-list');
  const habits = state.habits || [];
  if (!habits.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  // The break lock re-renders every second — rebuilding the rows would wipe an
  // amount the user is in the middle of typing, so only rebuild on real change.
  const sig = state.mode + '|' + habits.map((h) => `${h.id}:${h.timeReward}`).join(',');
  if (sig === habitSig) return;
  habitSig = sig;
  // Same picker, opposite meaning: on the budget lock a habit buys more screen
  // time, on a break lock it shortens the break. Saying "adds time" on a break
  // screen is the budget wording bleeding into the wrong lock.
  const isBudget = state.mode === 'budget';
  el('budget-hint').textContent = isBudget
    ? 'סימנת שהשלמת אחת מההרגלים האלה עכשיו? זה מוסיף זמן מסך:'
    : 'סימנת שהשלמת אחת מההרגלים האלה עכשיו? זה מקצר את ההפסקה:';
  list.innerHTML = '';
  for (const h of habits) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center; width:340px;';

    // How much you actually did — the reward scales with it, so "I did 3" is
    // worth three times "I did 1" instead of costing three clicks.
    const amt = document.createElement('input');
    amt.type = 'number';
    amt.className = 'reason-input habit-amt';
    amt.min = '0';
    amt.step = 'any';
    amt.value = '1';
    amt.style.cssText = 'width:78px; padding:10px; text-align:center;';

    const unit = document.createElement('span');
    unit.textContent = unitLabel(h);
    unit.style.cssText = 'font-size:13px; opacity:.7; min-width:48px;';

    const btn = document.createElement('button');
    btn.className = 'btn approve';
    btn.style.cssText = 'flex:1; min-width:0;';
    btn.textContent = `${h.emoji || '✅'} ${h.name}`;
    btn.title = isBudget
      ? `${h.timeReward} דק' מסך לכל יחידה`
      : `${h.timeReward} דק' פחות הפסקה לכל יחידה`;
    btn.addEventListener('click', async () => {
      const amount = parseFloat(String(amt.value).replace(',', '.'));
      if (!(amount > 0)) { amt.focus(); return; }
      btn.disabled = true;
      const st = await window.lock.logHabitForTime(h.id, amount);
      habitSig = null; // force a rebuild so the row resets
      render(st);
    });

    row.appendChild(amt);
    row.appendChild(unit);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// Time-budget lock: distinct from the break/approve-short flows above — no
// countdown, no approve-watchers ping, just "log a reward habit to unlock".
function renderBudget(state) {
  el('emoji').textContent = '⏳';
  el('title').textContent = 'נגמר זמן המסך';
  el('sub').textContent = 'עברת את תקציב הזמן היומי. השלימו הרגל כדי לקבל עוד זמן, או המתינו למחר.';
  // No countdown here — nothing is ticking down — so the break screen's
  // "time remaining" label and progress bar must not come along for the ride.
  el('count').textContent = fmt(state.overSeconds * 1000);
  el('count-lbl').textContent = 'מעל התקציב';
  el('bar-wrap').classList.add('hidden');

  el('approve').classList.add('hidden');
  el('approve-hint').classList.add('hidden');
  el('approve-reason-panel').classList.add('hidden');
  el('release').classList.toggle('hidden', !state.isDev);

  renderHabitPicker(state);
  applyUrgentUI();
}

function render(state) {
  if (!state || !state.locked) return;
  // A mode handover reuses the same window; the previous lock's total would
  // otherwise keep scaling the progress bar.
  if (lastState && lastState.mode !== state.mode) totalMs = 0;
  lastState = state;

  if (state.mode === 'budget') {
    renderBudget(state);
    return;
  }

  const isBreak = state.mode === 'break';
  el('emoji').textContent = isBreak ? '🔒' : '⏳';
  el('title').textContent = isBreak ? 'זמן להפסקה' : 'קום לרגע לבדוק';
  el('sub').textContent = isBreak
    ? 'קום, מתח את הגוף, ותן לעיניים לנוח. אי אפשר לצאת עד שהזמן נגמר.'
    : 'קום שנייה מהמחשב ותראה אם מישהו צריך אותך.';

  el('release').classList.toggle('hidden', !state.isDev);

  el('count').textContent = fmt(state.remainingMs);
  el('count-lbl').textContent = 'זמן שנותר';
  el('bar-wrap').classList.remove('hidden');
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

  renderHabitPicker(state);
  applyUrgentUI();
}

function applyUrgentUI() {
  el('urgent').classList.toggle('hidden', urgentOpen);
  el('urgent-panel').classList.toggle('hidden', !urgentOpen);
}

// Emergency valve: always available, in every lock mode. It really does unlock —
// the accountability is that the watchers are told immediately, with the reason.
el('urgent').addEventListener('click', () => {
  urgentOpen = true;
  el('urgent-reason-input').value = '';
  render(lastState);
  el('urgent-reason-input').focus();
});
el('urgent-back').addEventListener('click', () => { urgentOpen = false; render(lastState); });
el('urgent-send').addEventListener('click', async () => {
  const input = el('urgent-reason-input');
  const reason = input.value.trim();
  if (!reason) { input.reportValidity(); return; }
  el('urgent-send').disabled = true;
  await window.lock.urgent(reason);
  urgentOpen = false;
});
el('urgent-reason-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('urgent-send').click();
});

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
  const t = e.target;
  const typing = t && (t.id === 'approve-reason-input' || t.id === 'urgent-reason-input' || t.classList.contains('habit-amt'));
  if (typing && !e.altKey && !e.metaKey && e.key !== 'Escape' && e.key !== 'Tab') return;
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
