// Forest tab UI. Talks to the main-process session engine over window.api and
// renders with window.ForestArt. Loaded after renderer.js (reuses its page nav).
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const api = window.api;
  const Art = window.ForestArt;

  let state = null;        // last forest:getState payload
  let mode = 'timer';      // 'timer' | 'stopwatch'
  let pickedSpecies = null;
  let liveSession = null;  // last forest-tick payload
  let frange = 'day';      // my-forest range
  let foffset = 0;         // windows back from today
  let fdDraft = null;      // distractions editor draft

  const SPECIES_BY_ID = {};

  // ---------- helpers ----------
  function fmtDur(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function fmtClock(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
  }

  async function refresh() {
    state = await api.forestGetState();
    for (const s of state.species) SPECIES_BY_ID[s.id] = s;
    if (!pickedSpecies || !state.data.unlockedSpecies.includes(pickedSpecies)) {
      pickedSpecies = state.data.selectedSpecies;
    }
    liveSession = state.session;
    renderAll();
  }

  function renderAll() {
    $('#forest-coins-val').textContent = state.data.coins;
    renderPlant();
    renderTasks();
    renderMyForest();
    renderShop();
    renderStats();
    renderBadges();
  }

  // ---------- sub-tab switching ----------
  $$('.forest-subtabs .range-tab').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.forest-subtabs .range-tab').forEach((x) => x.classList.toggle('active', x === b));
      $$('.fview').forEach((v) => v.classList.toggle('hidden', v.id !== `fview-${b.dataset.fview}`));
    });
  });

  // ---------- Plant view ----------
  function renderPlant() {
    const active = !!liveSession;
    $('#forest-setup').classList.toggle('hidden', active);
    $('#forest-active').classList.toggle('hidden', !active);
    if (active) return renderActive();

    // species picker: unlocked first, locked greyed
    const picker = $('#forest-species-picker');
    picker.innerHTML = '';
    for (const sp of state.species) {
      const owned = state.data.unlockedSpecies.includes(sp.id);
      const el = document.createElement('button');
      el.className = 'forest-species' + (owned ? (sp.id === pickedSpecies ? ' selected' : '') : ' locked');
      el.title = owned ? sp.name : `${sp.name} — unlock in the Shop`;
      el.innerHTML = Art.treeSVG(sp.id, 3, { size: 56 });
      if (owned) {
        el.addEventListener('click', () => {
          pickedSpecies = sp.id;
          api.forestSelectSpecies(sp.id);
          renderPlant();
        });
      }
      picker.appendChild(el);
    }

    $('#forest-preview-tree').innerHTML = Art.treeSVG(pickedSpecies, 3, { size: 220 });
    $('#forest-timer-row').style.visibility = mode === 'timer' ? 'visible' : 'hidden';

    // tags
    const tagSel = $('#forest-tag');
    tagSel.innerHTML = state.data.tags.map((t) => `<option value="${t}">${t}</option>`).join('');

    // open tasks
    const taskSel = $('#forest-task');
    const open = state.data.tasks.filter((t) => !t.done);
    taskSel.innerHTML = '<option value="">No task</option>' +
      open.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join('');
  }

  function renderActive() {
    const s = liveSession;
    $('#forest-live-tree').innerHTML = Art.treeSVG(s.species, s.state === 'warning' ? s.stage : s.stage, { size: 220 });
    if (s.mode === 'timer') {
      $('#forest-live-timer').textContent = fmtClock(Math.max(0, s.plannedSec - s.elapsedSec));
    } else {
      $('#forest-live-timer').textContent = fmtClock(s.elapsedSec);
    }
    $('#forest-live-sub').textContent =
      s.state === 'paused' ? 'Paused' :
      s.state === 'warning' ? 'Your tree is in danger!' :
      s.mode === 'stopwatch' && s.elapsedSec < 600 ? `Focus at least 10 min or the tree dies` :
      'Stay focused!';

    const warning = s.state === 'warning';
    $('#forest-warning').classList.toggle('hidden', !warning);
    $('#forest-plant-card').classList.toggle('warning', warning);
    if (warning) $('#forest-warning-count').textContent = s.warningLeft;

    const pauseBtn = $('#forest-pause-btn');
    pauseBtn.textContent = s.state === 'paused' ? '▶ Resume' : '❙❙ Pause';
    pauseBtn.classList.toggle('hidden', !state.data.settings.allowPause);
    $('#forest-finish-btn').classList.toggle('hidden', s.mode !== 'stopwatch');
  }

  $('#forest-duration').addEventListener('input', (e) => {
    $('#forest-duration-val').textContent = e.target.value;
  });
  $('#forest-mode-timer').addEventListener('click', () => {
    mode = 'timer';
    $('#forest-mode-timer').classList.add('active');
    $('#forest-mode-stopwatch').classList.remove('active');
    $('#forest-timer-row').style.visibility = 'visible';
  });
  $('#forest-mode-stopwatch').addEventListener('click', () => {
    mode = 'stopwatch';
    $('#forest-mode-stopwatch').classList.add('active');
    $('#forest-mode-timer').classList.remove('active');
    $('#forest-timer-row').style.visibility = 'hidden';
  });

  $('#forest-plant-btn').addEventListener('click', async () => {
    const r = await api.forestStart({
      mode,
      plannedSec: Number($('#forest-duration').value) * 60,
      species: pickedSpecies,
      tag: $('#forest-tag').value,
      taskId: $('#forest-task').value || null
    });
    if (!r.ok) return toast('A session is already running');
    liveSession = r.session;
    renderPlant();
  });

  $('#forest-pause-btn').addEventListener('click', async () => {
    if (liveSession && liveSession.state === 'paused') await api.forestResume();
    else await api.forestPause();
  });
  $('#forest-giveup-btn').addEventListener('click', async () => {
    if (!confirm('Give up? Your tree will not survive.')) return;
    await api.forestGiveup();
  });
  $('#forest-finish-btn').addEventListener('click', () => api.forestFinish());

  // ---------- live events from main ----------
  api.onForestTick((s) => {
    liveSession = s;
    if (!$('#page-forest').classList.contains('hidden')) renderActive(), syncActiveVisibility();
  });
  api.onForestEnded(async ({ result, coinsEarned, tree, newAchievements }) => {
    liveSession = null;
    await refresh();
    showResult(result, coinsEarned, tree, newAchievements || []);
  });

  function syncActiveVisibility() {
    $('#forest-setup').classList.toggle('hidden', !!liveSession);
    $('#forest-active').classList.toggle('hidden', !liveSession);
  }

  // ---------- result modal + breathing ----------
  function showResult(result, coins, tree, achievements) {
    const modal = $('#forest-result-modal');
    const ok = result === 'success';
    $('#forest-result-tree').innerHTML = Art.treeSVG(tree.species, ok ? 3 : 'dead', { size: 160 });
    $('#forest-result-title').textContent =
      ok ? 'Your tree is fully grown!' :
      result === 'dead' ? 'Your tree died' : 'You gave up';
    $('#forest-result-sub').textContent =
      ok ? `${fmtDur(tree.actualSec)} of focus. It joined your forest.` :
      result === 'dead' ? 'You switched to a distracting app for too long.' :
      'The tree will be remembered in your forest.';
    $('#forest-result-coins').classList.toggle('hidden', !coins);
    $('#forest-result-coins-val').textContent = coins;
    $('#forest-result-achievements').innerHTML = achievements
      .map((a) => `<div class="forest-result-ach">\u{1F3C6} ${a.name} — ${a.desc}</div>`).join('');
    modal.classList.remove('hidden');
  }
  $('#forest-result-ok').addEventListener('click', () => $('#forest-result-modal').classList.add('hidden'));
  $('#forest-result-breathe').addEventListener('click', () => {
    $('#forest-result-modal').classList.add('hidden');
    startBreathing();
  });

  let breatheTimer = null;
  function startBreathing() {
    $('#forest-breathe').classList.remove('hidden');
    let phase = 0;
    $('#forest-breathe-text').textContent = 'Breathe in';
    breatheTimer = setInterval(() => {
      phase = 1 - phase;
      $('#forest-breathe-text').textContent = phase ? 'Breathe out' : 'Breathe in';
    }, 4000);
  }
  $('#forest-breathe-close').addEventListener('click', () => {
    $('#forest-breathe').classList.add('hidden');
    clearInterval(breatheTimer);
  });

  // ---------- Tasks ----------
  function renderTasks() {
    const list = $('#forest-task-list');
    const tasks = [...state.data.tasks].sort((a, b) => a.done - b.done || b.createdAt.localeCompare(a.createdAt));
    if (!tasks.length) {
      list.innerHTML = '<div class="forest-empty">No tasks yet — add one and plant a tree for it</div>';
      return;
    }
    list.innerHTML = '';
    for (const t of tasks) {
      const el = document.createElement('div');
      el.className = 'forest-task' + (t.done ? ' done' : '');
      el.innerHTML = `
        <button class="ft-check">${t.done ? '✓' : ''}</button>
        <span class="ft-title">${escapeHtml(t.title)}</span>
        <span class="ft-meta">
          ${t.treeCount ? `<span>\u{1F333} ${t.treeCount}</span>` : ''}
          ${t.focusSec ? `<span>⏱ ${fmtDur(t.focusSec)}</span>` : ''}
        </span>
        <button class="ft-del" title="Delete">✕</button>`;
      el.querySelector('.ft-check').addEventListener('click', async () => {
        await api.forestToggleTask(t.id);
        refresh();
      });
      el.querySelector('.ft-del').addEventListener('click', async () => {
        await api.forestDeleteTask(t.id);
        refresh();
      });
      list.appendChild(el);
    }
  }
  $('#forest-task-add-btn').addEventListener('click', addTask);
  $('#forest-task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
  async function addTask() {
    const inp = $('#forest-task-input');
    if (!inp.value.trim()) return;
    await api.forestAddTask(inp.value);
    inp.value = '';
    refresh();
  }

  // ---------- My Forest ----------
  function rangeWindow() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start); end.setDate(end.getDate() + 1);
    if (frange === 'day') {
      start.setDate(start.getDate() - foffset);
      end.setTime(start.getTime()); end.setDate(end.getDate() + 1);
    } else if (frange === 'week') {
      const dow = (start.getDay() + 6) % 7; // Monday-based
      start.setDate(start.getDate() - dow - foffset * 7);
      end.setTime(start.getTime()); end.setDate(end.getDate() + 7);
    } else if (frange === 'month') {
      start.setDate(1); start.setMonth(start.getMonth() - foffset);
      end.setTime(start.getTime()); end.setMonth(end.getMonth() + 1);
    } else {
      start.setMonth(0, 1); start.setFullYear(start.getFullYear() - foffset);
      end.setTime(start.getTime()); end.setFullYear(end.getFullYear() + 1);
    }
    return { start, end };
  }

  function rangeLabel(start) {
    if (frange === 'day') return foffset === 0 ? 'Today' : start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (frange === 'week') return foffset === 0 ? 'This week' : `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    if (frange === 'month') return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return String(start.getFullYear());
  }

  function renderMyForest() {
    const { start, end } = rangeWindow();
    $('#forest-nav-label').textContent = rangeLabel(start);
    $('#forest-nav-next').disabled = foffset === 0;

    const inRange = state.data.trees.filter((t) => {
      const d = new Date(t.startedAt);
      return d >= start && d < end;
    });
    const dio = $('#forest-diorama');
    if (!inRange.length) {
      dio.innerHTML = '<div class="forest-empty">\u{1F331} Nothing planted in this period yet</div>';
      $('#forest-diorama-summary').textContent = '';
      return;
    }
    // one tile per 16 trees
    dio.innerHTML = '';
    for (let i = 0; i < inRange.length; i += 16) {
      const chunk = inRange.slice(i, i + 16).map((t) => ({ species: t.species, result: t.result }));
      const holder = document.createElement('div');
      holder.innerHTML = Art.tileSVG(chunk, { size: 420 });
      dio.appendChild(holder);
    }
    const alive = inRange.filter((t) => t.result === 'success');
    const focusSec = alive.reduce((s, t) => s + t.actualSec, 0);
    $('#forest-diorama-summary').textContent =
      `${alive.length} trees grown · ${inRange.length - alive.length} lost · ${fmtDur(focusSec)} focused`;
  }

  $$('#forest-range-tabs .range-tab').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#forest-range-tabs .range-tab').forEach((x) => x.classList.toggle('active', x === b));
      frange = b.dataset.frange;
      foffset = 0;
      renderMyForest();
    });
  });
  $('#forest-nav-prev').addEventListener('click', () => { foffset++; renderMyForest(); });
  $('#forest-nav-next').addEventListener('click', () => { if (foffset > 0) { foffset--; renderMyForest(); } });

  // ---------- Shop ----------
  function renderShop() {
    const grid = $('#forest-shop-grid');
    grid.innerHTML = '';
    for (const sp of state.species) {
      const owned = state.data.unlockedSpecies.includes(sp.id);
      const selected = sp.id === state.data.selectedSpecies;
      const canBuy = state.data.coins >= sp.price;
      const card = document.createElement('div');
      card.className = 'forest-shop-card';
      card.innerHTML = `
        <div class="fs-art">${Art.treeSVG(sp.id, 3, { size: 120 })}</div>
        <div class="fs-name">${sp.name}</div>
        <div class="fs-price">${sp.price === 0 ? 'Free' : `<span class="coin-ico">⬤</span> ${sp.price}`}</div>
        <button class="forest-shop-btn ${selected ? 'selected' : owned ? 'owned' : canBuy ? 'buy' : 'cant'}">
          ${selected ? 'Selected' : owned ? 'Select' : canBuy ? 'Buy' : 'Not enough coins'}
        </button>`;
      const btn = card.querySelector('button');
      if (!owned && canBuy) {
        btn.addEventListener('click', async () => {
          const r = await api.forestBuySpecies(sp.id);
          if (r.ok) { toast(`${sp.name} unlocked!`); refresh(); }
        });
      } else if (owned && !selected) {
        btn.classList.add('buy');
        btn.addEventListener('click', async () => {
          await api.forestSelectSpecies(sp.id);
          pickedSpecies = sp.id;
          refresh();
        });
      }
      grid.appendChild(card);
    }
  }

  // ---------- Stats ----------
  function renderStats() {
    const trees = state.data.trees;
    const alive = trees.filter((t) => t.result === 'success');
    const dead = trees.length - alive.length;
    const totalSec = alive.reduce((s, t) => s + t.actualSec, 0);
    $('#fstat-total').textContent = fmtDur(totalSec);
    $('#fstat-alive').textContent = alive.length;
    $('#fstat-dead').textContent = dead;
    $('#fstat-rate').textContent = trees.length ? Math.round((alive.length / trees.length) * 100) + '%' : '—';

    // last 7 days bars
    const bars = $('#forest-bars');
    bars.innerHTML = '';
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const sec = alive.filter((t) => t.startedAt.slice(0, 10) === key).reduce((s, t) => s + t.actualSec, 0);
      days.push({ label: d.toLocaleDateString(undefined, { weekday: 'short' }), sec });
    }
    const max = Math.max(...days.map((d) => d.sec), 1);
    for (const d of days) {
      const el = document.createElement('div');
      el.className = 'forest-bar';
      el.innerHTML = `
        <div class="fb-val">${d.sec ? fmtDur(d.sec) : ''}</div>
        <div class="fb-fill" style="height:${Math.max(2, (d.sec / max) * 100)}%"></div>
        <div class="fb-lbl">${d.label}</div>`;
      bars.appendChild(el);
    }

    // by tag
    const tagStats = {};
    for (const t of alive) {
      const tag = t.tag || 'Untagged';
      tagStats[tag] = (tagStats[tag] || 0) + t.actualSec;
    }
    const rows = Object.entries(tagStats).sort((a, b) => b[1] - a[1]);
    const tmax = rows.length ? rows[0][1] : 1;
    $('#forest-tagstats').innerHTML = rows.length
      ? rows.map(([tag, sec]) => `
          <div class="forest-tagrow">
            <span class="tg-name">${escapeHtml(tag)}</span>
            <div class="tg-bar"><div class="tg-fill" style="width:${(sec / tmax) * 100}%"></div></div>
            <span class="tg-val">${fmtDur(sec)}</span>
          </div>`).join('')
      : '<div class="forest-empty">Complete a session to see tag stats</div>';
  }

  // ---------- Achievements ----------
  const BADGE_EMOJI = {
    'first-tree': '\u{1F331}', 'trees-10': '\u{1F333}', 'trees-50': '\u{1F332}',
    'focus-24h': '⏳', 'session-2h': '\u{1F3C3}', 'streak-7': '\u{1F525}',
    'coins-100': '\u{1FA99}', 'species-4': '\u{1F9EE}', 'tasks-10': '✅'
  };
  function renderBadges() {
    const grid = $('#forest-badges');
    grid.innerHTML = '';
    for (const a of state.achievementDefs) {
      const unlockedAt = state.data.achievements[a.id];
      const el = document.createElement('div');
      el.className = 'forest-badge' + (unlockedAt ? '' : ' locked');
      el.innerHTML = `
        <div class="fb-emoji">${BADGE_EMOJI[a.id] || '\u{1F3C6}'}</div>
        <div class="fb-name">${a.name}</div>
        <div class="fb-desc">${a.desc}</div>
        ${unlockedAt ? `<div class="fb-date">${new Date(unlockedAt).toLocaleDateString()}</div>` : ''}`;
      grid.appendChild(el);
    }
  }

  // ---------- Distractions editor ----------
  $('#forest-distractions-btn').addEventListener('click', async () => {
    fdDraft = JSON.parse(JSON.stringify(state.data.distractions));
    renderFdModal();
    // suggest apps used today
    try {
      const dash = await api.getDashboard('Today', 0, 'all');
      $('#fd-suggestions').innerHTML = (dash.topApplications || [])
        .map((a) => `<option value="${escapeHtml(a.name)}"></option>`).join('');
    } catch (e) { /* suggestions are optional */ }
    $('#forest-distract-modal').classList.remove('hidden');
  });

  function renderFdModal() {
    $('#fd-mode-block').classList.toggle('active', fdDraft.mode === 'blocklist');
    $('#fd-mode-allow').classList.toggle('active', fdDraft.mode === 'allowlist');
    $('#fd-mode-hint').textContent = fdDraft.mode === 'blocklist'
      ? 'Blocklist: listed apps kill your tree.'
      : 'Allowlist: every app EXCEPT the listed ones kills your tree.';
    const list = $('#fd-list');
    list.innerHTML = fdDraft.apps.length ? '' : '<div class="forest-empty" style="padding:14px 0">No apps listed</div>';
    fdDraft.apps.forEach((app, i) => {
      const el = document.createElement('div');
      el.className = 'fd-item';
      el.innerHTML = `<span>${escapeHtml(app)}</span><button title="Remove">✕</button>`;
      el.querySelector('button').addEventListener('click', () => {
        fdDraft.apps.splice(i, 1);
        renderFdModal();
      });
      list.appendChild(el);
    });
  }
  $('#fd-mode-block').addEventListener('click', () => { fdDraft.mode = 'blocklist'; renderFdModal(); });
  $('#fd-mode-allow').addEventListener('click', () => { fdDraft.mode = 'allowlist'; renderFdModal(); });
  $('#fd-add-btn').addEventListener('click', fdAdd);
  $('#fd-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') fdAdd(); });
  function fdAdd() {
    const v = $('#fd-input').value.trim();
    if (!v || fdDraft.apps.some((a) => a.toLowerCase() === v.toLowerCase())) return;
    fdDraft.apps.push(v);
    $('#fd-input').value = '';
    renderFdModal();
  }
  $('#fd-save-btn').addEventListener('click', async () => {
    await api.forestSetDistractions(fdDraft);
    $('#forest-distract-modal').classList.add('hidden');
    toast('Distractions saved');
    refresh();
  });
  $('#fd-cancel-btn').addEventListener('click', () => $('#forest-distract-modal').classList.add('hidden'));

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // refresh when navigating into the tab
  $$('.nav-item[data-page="forest"]').forEach((b) => b.addEventListener('click', refresh));

  refresh();
})();
