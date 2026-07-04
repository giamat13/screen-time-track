(function () {
  'use strict';
  if (window.__screenTimeInit) return; // guard against double-evaluation
  window.__screenTimeInit = true;

const api = window.api;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const DONUT_COLORS = ['#2e9bff', '#a78bfa', '#34d399', '#f5a623', '#475569'];
let dashRange = 'Today';
let statsRange = '7';
let dashOffset = 0;
let statsOffset = 0;
let lastHours = new Array(24).fill(0);
let trackingOn = true;
let studyOn = false;
let notMeOn = false;
let dashFilter = 'all';
let lastIdleSeconds = 0;
let brkSettings = {};
let brkStatusInterval = null;

// ---------- helpers ----------
function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}<small>h</small> ${m}<small>m</small> ${s}<small>s</small>`;
}
function fmtShort(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
function timeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning!';
  if (h < 18) return 'Good afternoon!';
  return 'Good evening!';
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- navigation ----------
function go(page) {
  if (brkStatusInterval && page !== 'breaks') { clearInterval(brkStatusInterval); brkStatusInterval = null; }
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('hidden', p.id !== `page-${page}`));
  if (page === 'dashboard') loadDashboard();
  if (page === 'statistics') loadStats();
  if (page === 'settings') loadSettings();
  if (page === 'breaks') loadBreaks();
  if (page === 'goals') loadGoals();
  if (page === 'streak') loadGoals();
  if (page === 'habits') loadHabits();
  if (page === 'reminders') loadReminders();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));
$('#hamburger').addEventListener('click', () => $('.sidebar').classList.toggle('collapsed'));

// window controls
$$('.tb-btn').forEach((b) => b.addEventListener('click', () => api.windowControl(b.dataset.win)));

// range tabs
$$('.range-tabs').forEach((group) => {
  const scope = group.dataset.scope;
  group.querySelectorAll('.range-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      group.querySelectorAll('.range-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      if (scope === 'dashboard') { dashRange = tab.dataset.range; dashOffset = 0; loadDashboard(); }
      else { statsRange = tab.dataset.range; statsOffset = 0; loadStats(); }
    });
  });
});

// date navigation (‹ / ›) — shift the viewed window back/forward by one range
$$('.date-nav').forEach((nav) => {
  const scope = nav.dataset.scope;
  nav.querySelectorAll('.date-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = btn.dataset.dir === 'prev' ? 1 : -1;
      if (scope === 'dashboard') { dashOffset = Math.max(0, dashOffset + delta); loadDashboard(); }
      else { statsOffset = Math.max(0, statsOffset + delta); loadStats(); }
    });
  });
});

function fmtRangeLabel(range, offset, d) {
  if (offset === 0) return range === 'Today' ? 'Today' : (range === '7' ? 'This week' : `Last ${range} days`);
  if (range === 'Today') {
    return offset === 1 ? 'Yesterday' : new Date((d.rangeStart || '') + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const fmtDay = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?';
  return `${fmtDay(d.rangeStart)} – ${fmtDay(d.rangeEnd)}`;
}

function applyNavState(scope, offset, range, d) {
  const nav = document.querySelector(`.date-nav[data-scope="${scope}"]`);
  if (!nav) return;
  nav.querySelector('[data-dir="next"]').disabled = offset === 0;
  const label = nav.querySelector('.date-nav-label');
  if (label) label.textContent = fmtRangeLabel(range, offset, d);
}
$('#refresh-btn').addEventListener('click', () => loadDashboard());
$('#hero-pause').addEventListener('click', async () => {
  const tracking = await api.toggleTracking();
  applyTrackingUI(tracking);
});

function applyStudyUI(on) {
  studyOn = !!on;
  const btn = $('#hero-study');
  if (btn) btn.classList.toggle('active', studyOn);
  const cb = $('#set-studymode');
  if (cb) cb.checked = studyOn;
}

async function toggleStudyMode(on) {
  if (on && notMeOn) { await api.endNotMe(); applyNotMeUI(false); } // mutually exclusive with Not Me
  await api.setSettings({ studyMode: on });
  applyStudyUI(on);
  toast(on ? '📚 Study Mode on — time tracked but not counted against limits' : 'Study Mode off');
  if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard();
}

$('#hero-study').addEventListener('click', () => toggleStudyMode(!studyOn));

function applyNotMeUI(on) {
  notMeOn = !!on;
  const btn = $('#hero-notme');
  if (btn) btn.classList.toggle('active', notMeOn);
  const cb = $('#set-notme');
  if (cb) cb.checked = notMeOn;
}

function openNotMeModal() {
  $('#notme-name').value = '';
  $('#notme-modal').classList.remove('hidden');
  $('#notme-name').focus();
}
function closeNotMeModal() {
  $('#notme-modal').classList.add('hidden');
  $('#set-notme').checked = notMeOn; // revert an in-flight checkbox click if cancelled
}

async function startNotMe(name) {
  if (studyOn) { await api.setSettings({ studyMode: false }); applyStudyUI(false); } // mutually exclusive
  await api.startNotMe(name);
  applyNotMeUI(true);
  toast(`👥 Not Me on — tracking paused for ${name}`);
  if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard();
}

async function endNotMe() {
  await api.endNotMe();
  applyNotMeUI(false);
  toast('Not Me off — tracking resumed');
  if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard();
}

$('#hero-notme').addEventListener('click', () => { notMeOn ? endNotMe() : openNotMeModal(); });
$('#set-notme').addEventListener('change', (e) => { e.target.checked ? openNotMeModal() : endNotMe(); });
$('#notme-cancel-btn').addEventListener('click', closeNotMeModal);
$('#notme-start-btn').addEventListener('click', () => {
  const name = $('#notme-name').value.trim() || 'Someone else';
  $('#notme-modal').classList.add('hidden');
  startNotMe(name);
});
$('#notme-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#notme-start-btn').click(); });

$('#dash-filter').addEventListener('change', (e) => { dashFilter = e.target.value; loadDashboard(); });

// ---------- dashboard ----------
async function loadDashboard() {
  const d = await api.getDashboard(dashRange, dashOffset, dashFilter);
  $('#greeting').textContent = timeOfDay();
  $('#today-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  applyNavState('dashboard', dashOffset, dashRange, d);

  const viewing = dashOffset === 0 ? '' : ` · ${fmtRangeLabel(dashRange, dashOffset, d)}`;
  $('#hero-label').textContent = (dashRange === 'Today' ? "Today's Screen Time" : `Screen Time (${labelFor(dashRange)})`) + viewing;
  $('#hero-time').innerHTML = fmtLong(d.total);

  $('#s-apps').textContent = d.appsUsed;
  $('#s-most').textContent = d.mostUsed;
  $('#s-avg').textContent = fmtShort(d.dailyAvg);
  $('#s-topapp').textContent = fmt(d.topAppTime);

  renderDonut(d.distribution, d.total);
  renderTopApps(d.topApplications);

  // session
  const st = await api.getState();
  $('#sess-start').textContent = st.session.startedAt ? new Date(st.session.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  $('#sess-apps').textContent = st.session.apps;
  $('#sess-focus').textContent = st.session.focus + '%';
  $('#hero-current-app').textContent = st.currentApp || '—';

  // trend
  $('#trend-today').textContent = fmtShort(d.trend.today);
  $('#trend-yest').textContent = fmtShort(d.trend.yesterday);
  const pct = d.trend.pct;
  $('#trend-badge').textContent = (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '%';
  $('#trend-note').textContent = pct >= 0 ? `Up ${Math.abs(pct)}% from yesterday` : `Down ${Math.abs(pct)}% from yesterday`;

  applyTrackingUI(st.tracking, st.paused);
}
function labelFor(r) { return r === 'Today' ? 'Today' : `${r} Days`; }

function renderDonut(dist, total) {
  const svg = $('#donut');
  svg.innerHTML = '';
  $('#donut-total').textContent = fmtShort(total);
  $('#dist-count').textContent = `${dist.length} app${dist.length === 1 ? '' : 's'}`;
  const cx = 90, cy = 90, r = 64, sw = 26;
  const C = 2 * Math.PI * r;
  const sum = dist.reduce((s, a) => s + a.sec, 0) || 1;

  // track
  svg.appendChild(circle(cx, cy, r, '#20242e', sw));
  let offset = 0;
  dist.forEach((seg, i) => {
    const frac = seg.sec / sum;
    const len = frac * C;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', DONUT_COLORS[i % DONUT_COLORS.length]);
    c.setAttribute('stroke-width', sw);
    c.setAttribute('stroke-dasharray', `${len} ${C - len}`);
    c.setAttribute('stroke-dashoffset', -offset);
    c.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    svg.appendChild(c);
    offset += len;
  });

  const legend = $('#dist-legend');
  legend.innerHTML = '';
  if (!dist.length) { legend.innerHTML = '<div class="subtle">No usage yet</div>'; return; }
  dist.forEach((seg, i) => {
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct = Math.round((seg.sec / sum) * 100);
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="sq" style="background:${color}"></span>
      <span class="name">${escapeHtml(seg.name)}</span>
      <span class="bar"><span style="width:${pct}%;background:${color}"></span></span>
      <span class="val">${fmt(seg.sec)}</span>`;
    legend.appendChild(row);
  });
}
function circle(cx, cy, r, stroke, sw) {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
  c.setAttribute('fill', 'none'); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', sw);
  return c;
}

function renderTopApps(apps) {
  const ol = $('#top-list');
  ol.innerHTML = '';
  if (!apps.length) { ol.innerHTML = '<li class="subtle">No usage yet</li>'; return; }
  const max = apps[0].sec || 1;
  apps.forEach((a, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank">${i + 1}</span>
      <span class="top-name">${escapeHtml(a.name)}</span>
      <span class="top-track"><span style="width:${Math.round((a.sec / max) * 100)}%"></span></span>
      <span class="top-val">${fmt(a.sec)}</span>`;
    ol.appendChild(li);
  });
}

function applyTrackingUI(tracking, idle, idleSecs) {
  trackingOn = tracking;
  const pill = $('#tb-status');
  const txt = $('#tb-status-text');
  const hero = $('.hero');

  if (!tracking) {
    pill.classList.add('paused'); txt.textContent = 'Paused';
    if (hero) { hero.classList.remove('idle'); hero.classList.add('paused'); }
  } else if (idle) {
    pill.classList.add('paused'); txt.textContent = 'Idle';
    if (hero) { hero.classList.add('idle'); hero.classList.remove('paused'); }
    // update the idle banner message with how long
    const msg = $('#hero-idle-msg');
    if (msg && idleSecs != null) {
      const m = Math.floor(idleSecs / 60);
      const s = Math.round(idleSecs % 60);
      msg.textContent = m > 0
        ? `No activity for ${m}m ${s}s — time not counted`
        : `No activity for ${s}s — time not counted`;
    }
  } else {
    pill.classList.remove('paused'); txt.textContent = 'Tracking';
    if (hero) { hero.classList.remove('idle'); hero.classList.remove('paused'); }
  }
  $('#hero-pause').innerHTML = tracking ? '&#10073;&#10073; Pause' : '&#9654; Resume';
}

// ---------- statistics ----------
async function loadStats() {
  const d = await api.getStats(statsRange, statsOffset);
  applyNavState('stats', statsOffset, statsRange, d);
  renderPeakHours(d.hours || []);
  renderDayOfWeek(d.dayOfWeek);
  renderStatTrend(d.trendAnalysis);
  $('#st-total').textContent = fmtShort(d.total);
  $('#st-avg').textContent = fmtShort(d.dailyAvg);
  $('#st-apps').textContent = d.appsUsed;
  const peak = d.perDay.reduce((m, x) => (x.total > (m ? m.total : -1) ? x : m), null);
  $('#st-peak').textContent = peak && peak.total > 0 ? new Date(peak.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

  // daily bars
  const bars = $('#day-bars');
  bars.innerHTML = '';
  const max = Math.max(...d.perDay.map((x) => x.total), 1);
  const show = d.perDay.slice(-Math.min(d.perDay.length, 30));
  show.forEach((day) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const h = Math.round((day.total / max) * 100);
    const dt = new Date(day.date);
    col.innerHTML = `<div class="bval">${day.total > 0 ? fmtShort(day.total) : ''}</div>
      <div class="fill" style="height:${h}%"></div>
      <div class="blabel">${dt.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</div>`;
    bars.appendChild(col);
  });

  // app breakdown
  const bd = $('#app-breakdown');
  bd.innerHTML = '';
  if (!d.topApplications.length) { bd.innerHTML = '<div class="subtle">No usage in this range yet</div>'; return; }
  const bmax = d.topApplications[0].sec || 1;
  d.topApplications.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'bd-row';
    row.innerHTML = `<span class="name">${escapeHtml(a.name)}</span>
      <span class="bar"><span style="width:${Math.round((a.sec / bmax) * 100)}%"></span></span>
      <span class="val">${fmt(a.sec)}</span>`;
    bd.appendChild(row);
  });
}

// peak hours: 24 bars + a scrubber that shows cumulative usage up to a chosen hour
function renderPeakHours(hours) {
  lastHours = Array.isArray(hours) && hours.length === 24 ? hours : new Array(24).fill(0);
  const bars = $('#hour-bars');
  bars.innerHTML = '';
  const max = Math.max(...lastHours, 1);
  const peakIdx = lastHours.indexOf(Math.max(...lastHours));
  const total = lastHours.reduce((s, x) => s + x, 0);
  $('#peak-hour-badge').textContent = total > 0
    ? `Busiest ${String(peakIdx).padStart(2, '0')}:00`
    : 'No data yet';

  lastHours.forEach((sec, h) => {
    const col = document.createElement('div');
    col.className = 'hour-col' + (h === peakIdx && total > 0 ? ' peak' : '');
    const ht = Math.round((sec / max) * 100);
    col.title = `${String(h).padStart(2, '0')}:00 — ${fmt(sec)}`;
    col.innerHTML = `<div class="hfill" style="height:${ht}%"></div>` +
      (h % 3 === 0 ? `<div class="hlabel">${h}</div>` : `<div class="hlabel">&nbsp;</div>`);
    bars.appendChild(col);
  });
  updateHourScrub();
}

function updateHourScrub() {
  const hr = parseInt($('#hour-scrub').value, 10);
  $('#hour-scrub-time').textContent = `${String(hr).padStart(2, '0')}:00`;
  const cum = lastHours.slice(0, hr + 1).reduce((s, x) => s + x, 0);
  const total = lastHours.reduce((s, x) => s + x, 0) || 1;
  $('#hour-scrub-total').textContent = fmt(cum);
  $('#hour-scrub-pct').textContent = Math.round((cum / total) * 100) + '%';
  // highlight bars up to the scrubbed hour
  $$('#hour-bars .hour-col').forEach((col, i) => col.classList.toggle('dim', i > hr));
}
$('#hour-scrub').addEventListener('input', updateHourScrub);

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function renderDayOfWeek(dow) {
  const bars = $('#dow-bars');
  bars.innerHTML = '';
  if (!dow || !dow.week) return;
  const max = Math.max(...dow.week.map((w) => w.avg), 1);
  dow.week.forEach((w) => {
    const col = document.createElement('div');
    const isLow = dow.lowest && w.dow === dow.lowest.dow && w.avg > 0;
    const isHigh = dow.highest && w.dow === dow.highest.dow && w.avg > 0;
    col.className = 'dow-col' + (isLow ? ' low' : '') + (isHigh ? ' high' : '');
    const h = Math.round((w.avg / max) * 100);
    col.innerHTML = `<div class="dval">${w.avg > 0 ? fmtShort(w.avg) : ''}</div>
      <div class="dfill" style="height:${h}%"></div>
      <div class="dlabel">${DOW_NAMES[w.dow].slice(0, 2)}</div>`;
    bars.appendChild(col);
  });
  const sum = $('#dow-summary');
  if (dow.lowest) {
    sum.innerHTML = `<span class="dow-tag low">🏆 Least screen: <strong>${DOW_NAMES[dow.lowest.dow]}</strong> (${fmtShort(dow.lowest.avg)}/day avg)</span>`;
  } else {
    sum.innerHTML = '<span class="subtle small">Not enough data yet</span>';
  }
}

function renderStatTrend(t) {
  if (!t) return;
  $('#stat-trend-recent').textContent = fmtShort(t.recentAvg);
  $('#stat-trend-prior').textContent = fmtShort(t.priorAvg);
  const badge = $('#stat-trend-badge');
  const arrow = t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '→';
  badge.textContent = `${arrow} ${Math.abs(t.pct)}%`;
  badge.className = 'badge ' + (t.direction === 'up' ? 'bad' : t.direction === 'down' ? 'good' : '');
  const note = $('#stat-trend-note');
  if (t.direction === 'up') note.textContent = `Usage trending up ${Math.abs(t.pct)}% vs the previous week.`;
  else if (t.direction === 'down') note.textContent = `Nice — usage trending down ${Math.abs(t.pct)}% vs the previous week.`;
  else note.textContent = 'Usage is holding steady week over week.';
}

// ---------- settings ----------
async function loadSettings() {
  const s = await api.getSettings();
  $('#set-tracking').checked = !!s.tracking;
  applyStudyUI(!!s.studyMode);
  applyNotMeUI(!!s.notMe);
  $('#set-autolaunch').checked = !!s.autoLaunch;
  $('#set-tray').checked = !!s.minimizeToTray;
  $('#set-blocking').checked = !!s.blockingEnabled;
  $('#set-idle').value = String(s.idleThreshold || 30);
  $('#set-interval').value = String(s.pollInterval || 2);
  $('#set-brk-devmode').checked = !!(s.breakReminder && s.breakReminder.devMode);
}
$('#set-tracking').addEventListener('change', async (e) => { await api.setTracking(e.target.checked); });
$('#set-studymode').addEventListener('change', (e) => toggleStudyMode(e.target.checked));
$('#set-autolaunch').addEventListener('change', (e) => api.setSettings({ autoLaunch: e.target.checked }));
$('#set-tray').addEventListener('change', (e) => api.setSettings({ minimizeToTray: e.target.checked }));
$('#set-idle').addEventListener('change', (e) => api.setSettings({ idleThreshold: parseInt(e.target.value, 10) }));
$('#set-interval').addEventListener('change', (e) => { api.setSettings({ pollInterval: parseInt(e.target.value, 10) }); toast('Restart to apply new interval'); });

$('#dbg-remove-btn').addEventListener('click', async () => {
  const min = parseFloat($('#dbg-remove-min').value);
  if (!min || min <= 0) { toast('Enter minutes to remove'); return; }
  await api.debugSubtractTime(min * 60);
  $('#dbg-remove-min').value = '';
  toast(`🧪 Removed ${min}m from today`);
  if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard();
});

$('#dbg-other-btn').addEventListener('click', async () => {
  const name = $('#dbg-other-name').value.trim();
  const min = parseFloat($('#dbg-other-min').value);
  if (!name) { toast('Enter who it was'); return; }
  if (!min || min <= 0) { toast('Enter minutes'); return; }
  await api.debugSubtractTime(min * 60);
  $('#dbg-other-name').value = '';
  $('#dbg-other-min').value = '';
  toast(`🧪 ${min}m attributed to ${name}, removed from your time`);
  if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard();
});
$('#set-brk-devmode').addEventListener('change', async (e) => {
  await api.setSettings({ breakReminder: { devMode: e.target.checked } });
  applyDevRows(e.target.checked); // keep the Breaks-page control in sync
  toast(e.target.checked ? 'Dev mode on — breaks use seconds' : 'Dev mode off');
});
$('#set-reset').addEventListener('click', async () => { await api.resetSession(); toast('Session reset'); if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard(); });

// ---------- break reminder ----------
async function loadBreaks() {
  const s = await api.getSettings();
  brkSettings = Object.assign({
    enabled: false, checkIntervalMinutes: 60,
    devMode: false, checkIntervalSeconds: 10,
    beepFrequency: 1000, beepDuration: 200, beepIntervalSeconds: 0.4
  }, s.breakReminder || {});

  $('#brk-enabled').checked = !!brkSettings.enabled;
  $('#brk-interval').value = brkSettings.checkIntervalMinutes;
  $('#brk-interval-sec').value = brkSettings.checkIntervalSeconds;
  $('#brk-freq').value = brkSettings.beepFrequency;
  $('#brk-dur').value = brkSettings.beepDuration;
  $('#brk-beep-int').value = brkSettings.beepIntervalSeconds;
  applyDevRows(!!brkSettings.devMode);
  updateBrkLabels();
  await updateBrkStatus();

  if (brkStatusInterval) clearInterval(brkStatusInterval);
  brkStatusInterval = setInterval(updateBrkStatus, 10000);
}

async function updateBrkStatus() {
  const status = await api.getBreakStatus();
  if (!brkSettings.enabled) {
    $('#brk-status-title').textContent = 'Disabled';
    $('#brk-status-sub').textContent = 'Enable to receive break reminders';
    return;
  }
  if (status.isBeeping) {
    $('#brk-status-title').textContent = '🔔 Ringing now!';
    $('#brk-status-sub').textContent = 'Open the app and choose how to answer the alarm to silence it';
    return;
  }
  if (status.nextCheckAt) {
    const remMs = status.nextCheckAt - Date.now();
    const label = remMs < 60000
      ? `${Math.max(0, Math.round(remMs / 1000))}s`
      : `${Math.round(remMs / 60000)}m`;
    const owe = status.owedExtraMinutes > 0 ? ` · you owe +${status.owedExtraMinutes}m of rest` : '';
    $('#brk-status-title').textContent = `Next reminder in ${label}`;
    $('#brk-status-sub').textContent = `Will only ring if you're at the computer during the check${owe}`;
  } else {
    $('#brk-status-title').textContent = 'Active';
    $('#brk-status-sub').textContent = 'Waiting for the next check cycle';
  }
}

function updateBrkLabels() {
  const mins = parseInt($('#brk-interval').value);
  $('#brk-interval-val').textContent = mins >= 60
    ? `${Math.floor(mins / 60)}h ${mins % 60 ? (mins % 60) + 'm' : ''}`.trim()
    : `${mins}m`;
  $('#brk-interval-sec-val').textContent = `${$('#brk-interval-sec').value}s`;
  $('#brk-freq-val').textContent = `${$('#brk-freq').value} Hz`;
  $('#brk-dur-val').textContent = `${$('#brk-dur').value}ms`;
  $('#brk-beep-int-val').textContent = `${parseFloat($('#brk-beep-int').value).toFixed(1)}s`;
}

// Show the seconds-based "Break every" control when dev mode is on, minutes otherwise.
function applyDevRows(dev) {
  $('#brk-min-row').classList.toggle('hidden', dev);
  $('#brk-sec-row').classList.toggle('hidden', !dev);
}

async function saveBrkSettings() {
  // devMode is owned by the Settings page; omit it so the deep-merge preserves it
  brkSettings = {
    enabled: $('#brk-enabled').checked,
    checkIntervalMinutes: parseInt($('#brk-interval').value),
    checkIntervalSeconds: parseInt($('#brk-interval-sec').value),
    beepFrequency: parseInt($('#brk-freq').value),
    beepDuration: parseInt($('#brk-dur').value),
    beepIntervalSeconds: parseFloat($('#brk-beep-int').value),
  };
  await api.setSettings({ breakReminder: brkSettings });
  await updateBrkStatus();
}

$('#brk-enabled').addEventListener('change', saveBrkSettings);
$('#brk-test').addEventListener('click', () => api.testBreak());
['brk-interval', 'brk-interval-sec', 'brk-freq', 'brk-dur', 'brk-beep-int'].forEach((id) => {
  const el = $(`#${id}`);
  el.addEventListener('input', updateBrkLabels);
  el.addEventListener('change', saveBrkSettings);
});

// ---------- break alarm prompt ----------
function showBreakModal(d) {
  d = d || {};
  const rec = d.recommendedBreakMinutes || 5;
  $('#brk-modal-sub').textContent =
    `You've been at the computer for a while. Step away for about ${rec} minutes and rest your eyes.`;
  const note = $('#brk-modal-note');
  if (d.owedExtraMinutes > 0) {
    note.textContent = `⚠️ You skipped a break earlier — you now owe an extra ${d.owedExtraMinutes} minutes of rest.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
  $('#break-modal').classList.remove('hidden');
}

function hideBreakModal() { $('#break-modal').classList.add('hidden'); }

$$('#break-modal .modal-btn').forEach((b) => b.addEventListener('click', async () => {
  hideBreakModal();
  await api.respondBreak(b.dataset.choice);
  if ($('#page-breaks') && !$('#page-breaks').classList.contains('hidden')) updateBrkStatus();
}));

api.onBreakPrompt((d) => showBreakModal(d));

// ---------- goals & streaks ----------
let goalsData = {};
let globalLimit = 0; // total daily cap (seconds), 0 = off

function rendDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadGoals() {
  const [goals, streaks, weekly, dash, gLimit, habits] = await Promise.all([
    api.getGoals(),
    api.getStreaks(),
    api.getWeeklyReport(),
    api.getDashboard('Today'),
    api.getGlobalLimit(),
    api.getHabits()
  ]);
  goalsData = goals;
  globalLimit = gLimit || 0;
  renderGlobalLimit(dash);
  renderStreak(streaks);
  renderStreakGoals(goals, dash, gLimit);
  renderStreakHabits(habits);
  renderWeeklyReport(weekly);
  renderGoalsList(goals, dash);
}

// Shown on the Streak page: screen-time goals so the user can see what's still needed today.
function renderStreakGoals(goals, dash, gLimit) {
  const card = $('#streak-goals-card');
  const list = $('#streak-goals-list');
  if (!card || !list) return;
  const hasGoals = Object.keys(goals).length > 0 || gLimit > 0;
  if (!hasGoals) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.innerHTML = '';
  const apps = (dash && dash.apps) || {};
  const studyApps = (dash && dash.studyApps) || {};

  const makeRow = (name, icon, used, limit) => {
    const met = used <= limit;
    const row = document.createElement('div');
    row.className = 'streak-goal-row';
    row.innerHTML = `
      <span class="sg-icon">${icon}</span>
      <span class="sg-name">${escapeHtml(name)}</span>
      <span class="sg-prog${met ? '' : ' over'}">${fmtShort(used)} / ${fmtShort(limit)}</span>
      <span class="sg-check ${met ? 'done' : 'fail'}">${met ? '✓' : '✗'}</span>`;
    list.appendChild(row);
  };

  if (gLimit > 0) {
    const used = dash ? Math.max(0, (dash.total || 0) - (dash.studyTotal || 0)) : 0;
    makeRow('Total screen time', '🖥️', used, gLimit);
  }
  Object.entries(goals).forEach(([appName, limitSec]) => {
    const used = Math.max(0, ((apps[appName] || 0) - (studyApps[appName] || 0)));
    makeRow(appName, '📱', used, limitSec);
  });
}

// Shown on the Streak page: the habits that feed the unified streak, with today's /
// this-week's progress so it's clear what still needs doing to keep the day green.
function renderStreakHabits(habits) {
  const card = $('#streak-habits-card');
  const list = $('#streak-habits-list');
  if (!card || !list) return;
  if (!habits.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.innerHTML = '';
  habits.forEach((h) => {
    const u = h.unit === 'minutes' ? 'm' : h.unit === 'custom' ? ` ${customUnitLabel(h)}` : '';
    const per = h.freqType === 'weekly' ? 'this week' : 'today';
    const row = document.createElement('div');
    row.className = 'streak-habit-row';
    row.style.setProperty('--hc', h.color || '#2e9bff');
    row.innerHTML = `
      <span class="sh-emoji">${escapeHtml(h.emoji)}</span>
      <span class="sh-name">${escapeHtml(h.name)}</span>
      <span class="sh-prog">${h.periodCount}/${h.periodTarget}${u} ${per}</span>
      <span class="sh-check ${h.periodDone ? 'done' : ''}">${h.periodDone ? '✓' : '○'}</span>`;
    list.appendChild(row);
  });
}

function renderGlobalLimit(dash) {
  const on = globalLimit > 0;
  const mins = on ? Math.round(globalLimit / 60) : 120;
  $('#global-limit-on').checked = on;
  const pick = $('#global-limit-pick');
  pick.value = mins;
  pick.disabled = !on;
  $('#global-limit-val').textContent = fmtShort(mins * 60);
  const used = dash ? ((dash.total || 0) - (dash.studyTotal || 0)) : 0; // study excluded from the limit
  $('#global-limit-status').textContent = on ? `Today: ${fmt(used)} / ${fmtShort(globalLimit)}` : 'Off';
}

function renderStreak(streaks) {
  const { current, best, metDays, freezers = 0, frozenDays = {} } = streaks;
  $('#streak-current').textContent = current;
  $('#streak-best').textContent = best;
  $('#streak-freezers').textContent = freezers;
  $('#streak-freezer-hint').textContent = `(earn 1 every 3 days — saves a broken streak)`;
  const flame = $('#flame-icon');
  if (current === 0) flame.classList.add('cold'); else flame.classList.remove('cold');
  const msgs = ['Start a streak by meeting your goals today!', 'Great start — keep it going!', 'On a roll!', 'Impressive consistency!', 'Unstoppable!'];
  $('#streak-msg').textContent = current === 0 ? msgs[0] : current < 3 ? msgs[1] : current < 7 ? msgs[2] : current < 14 ? msgs[3] : msgs[4];

  const cal = $('#streak-calendar');
  cal.innerHTML = '';
  const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const hasGoals = Object.keys(goalsData).length > 0 || globalLimit > 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = rendDateKey(d);
    const dayLbl = DAY_NAMES[d.getDay()];
    const met = metDays && metDays[key];
    const isFrozen = frozenDays && frozenDays[key];
    let cls = '';
    if (hasGoals) cls = isFrozen ? 'frozen' : (met === true ? 'met' : (met === false ? 'unmet' : ''));
    const title = isFrozen ? `${key} — saved by a freezer ❄️` : key;
    const wrap = document.createElement('div');
    wrap.className = 'streak-dot-wrap';
    wrap.innerHTML = `<div class="streak-dot ${cls}" title="${title}">${isFrozen ? '❄️' : ''}</div><div class="sd-day">${dayLbl}</div>`;
    cal.appendChild(wrap);
  }
}

function renderWeeklyReport(weekly) {
  const { days, total, prevWeekTotal, apps } = weekly;
  $('#weekly-total').textContent = fmtShort(total);
  if (prevWeekTotal > 0) {
    const pct = Math.round(((total - prevWeekTotal) / prevWeekTotal) * 100);
    $('#weekly-vs').textContent = (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '% vs last week';
  } else {
    $('#weekly-vs').textContent = '';
  }

  const barsEl = $('#weekly-bars');
  barsEl.innerHTML = '';
  const max = Math.max(...days.map((d) => d.total), 1);
  const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  days.forEach((day) => {
    const d = new Date(day.date + 'T00:00:00');
    const h = Math.round((day.total / max) * 100);
    const col = document.createElement('div');
    col.className = 'weekly-col' + (day.goalMet === true ? ' met' : '');
    col.innerHTML = `<div class="wval">${day.total > 0 ? fmtShort(day.total) : ''}</div>
      <div class="wfill" style="height:${h}%"></div>
      <div class="wlabel">${DAY_NAMES[d.getDay()]}</div>`;
    barsEl.appendChild(col);
  });

  const appsEl = $('#weekly-apps');
  appsEl.innerHTML = '';
  const topApps = Object.entries(apps).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!topApps.length) { appsEl.innerHTML = '<div class="subtle">No usage this week</div>'; return; }
  const appMax = topApps[0][1] || 1;
  topApps.forEach(([name, sec]) => {
    const row = document.createElement('div');
    row.className = 'bd-row';
    row.innerHTML = `<span class="name">${escapeHtml(name)}</span>
      <span class="bar"><span style="width:${Math.round((sec / appMax) * 100)}%"></span></span>
      <span class="val">${fmt(sec)}</span>`;
    appsEl.appendChild(row);
  });
}

function renderGoalsList(goals, dash) {
  const list = $('#goals-list');
  const entries = Object.entries(goals);
  if (!entries.length) {
    list.innerHTML = '<div class="goals-empty">No limits yet — click "Add Limit" to cap daily usage of an app</div>';
    return;
  }
  list.innerHTML = '';
  const todayMap = {};
  (dash.topApplications || []).forEach((a) => { todayMap[a.name] = a.sec; });

  entries.forEach(([appName, targetSec]) => {
    const actual = todayMap[appName] || 0;
    const pct = Math.min(100, Math.round((actual / targetSec) * 100));
    const over = actual > targetSec;
    const barColor = over ? 'var(--pink)' : pct >= 80 ? 'var(--amber)' : '';
    const row = document.createElement('div');
    row.className = 'goal-row';
    row.innerHTML = `<div class="goal-info">
        <div class="goal-name">${escapeHtml(appName)}</div>
        <div class="goal-progress-wrap">
          <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%;${barColor ? 'background:' + barColor : ''}"></div></div>
          <span class="goal-time">${fmt(actual)} / ${fmt(targetSec)}</span>
          ${over ? '<span style="color:var(--pink);font-size:15px" title="Limit exceeded">⚠</span>' : ''}
        </div>
      </div>
      <button class="goal-del" data-app="${escapeHtml(appName)}" title="Remove goal">✕</button>`;
    list.appendChild(row);
  });

  list.querySelectorAll('.goal-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.setGoal(btn.dataset.app, 0);
      const [goals, streaks, dash2] = await Promise.all([api.getGoals(), api.getStreaks(), api.getDashboard('Today')]);
      goalsData = goals;
      renderStreak(streaks);
      renderGoalsList(goalsData, dash2);
      toast('Goal removed');
    });
  });
}

$('#goals-add-btn').addEventListener('click', async () => {
  const form = $('#goals-add-form');
  const isHidden = form.classList.contains('hidden');
  form.classList.toggle('hidden', !isHidden);
  if (isHidden) {
    const d = await api.getDashboard('7');
    const pick = $('#goals-app-pick');
    pick.innerHTML = '';
    const apps = (d.topApplications || []).filter((a) => !goalsData[a.name]);
    if (!apps.length) {
      const opt = document.createElement('option');
      opt.textContent = 'All recent apps already have limits';
      pick.appendChild(opt);
    } else {
      apps.forEach((a) => {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.name;
        pick.appendChild(opt);
      });
    }
  }
});

$('#goals-cancel-btn').addEventListener('click', () => $('#goals-add-form').classList.add('hidden'));

// ---- global (all-apps) daily limit ----
async function saveGlobalLimit() {
  const on = $('#global-limit-on').checked;
  const mins = parseInt($('#global-limit-pick').value);
  globalLimit = on ? mins * 60 : 0;
  await api.setGlobalLimit(globalLimit);
  const [streaks, dash] = await Promise.all([api.getStreaks(), api.getDashboard('Today')]);
  renderGlobalLimit(dash);
  renderStreak(streaks);
  toast(on ? `Total limit: up to ${fmtShort(globalLimit)}/day` : 'Total limit removed');
}

$('#global-limit-on').addEventListener('change', () => {
  $('#global-limit-pick').disabled = !$('#global-limit-on').checked;
  saveGlobalLimit();
});

$('#global-limit-pick').addEventListener('input', () => {
  $('#global-limit-val').textContent = fmtShort(parseInt($('#global-limit-pick').value) * 60);
});
$('#global-limit-pick').addEventListener('change', () => {
  if ($('#global-limit-on').checked) saveGlobalLimit();
});

$('#goals-time-pick').addEventListener('input', () => {
  const v = parseInt($('#goals-time-pick').value);
  const h = Math.floor(v / 60);
  const m = v % 60;
  $('#goals-time-val').textContent = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
});

$('#goals-save-btn').addEventListener('click', async () => {
  const appName = $('#goals-app-pick').value;
  const mins = parseInt($('#goals-time-pick').value);
  if (!appName || !mins) return;
  await api.setGoal(appName, mins * 60);
  $('#goals-add-form').classList.add('hidden');
  const [goals, streaks, dash] = await Promise.all([api.getGoals(), api.getStreaks(), api.getDashboard('Today')]);
  goalsData = goals;
  renderStreak(streaks);
  renderGoalsList(goalsData, dash);
  toast(`Limit set: ${appName} — up to ${fmtShort(mins * 60)}/day`);
});

// ---------- reminders ----------
async function loadReminders() {
  const reminders = await api.getReminders();
  renderReminders(reminders);
}

function renderReminders(reminders) {
  const list = $('#rem-list');
  if (!reminders.length) {
    list.innerHTML = '<div class="rem-empty subtle">No reminders yet — click &ldquo;+ Add Reminder&rdquo; to create one</div>';
    return;
  }
  list.innerHTML = '';
  reminders.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'card rem-card';
    card.innerHTML = `
      <div class="setting">
        <div style="display:flex;align-items:center;gap:14px">
          <span style="font-size:26px">&#128276;</span>
          <div>
            <div class="set-title" style="margin-bottom:2px">${escapeHtml(r.message)}</div>
            <div class="subtle">${r.time}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch">
            <input type="checkbox" class="rem-toggle" data-id="${escapeHtml(r.id)}" ${r.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
          <button class="btn ghost rem-del" data-id="${escapeHtml(r.id)}" style="padding:6px 12px;font-size:13px">&#10005;</button>
        </div>
      </div>`;
    list.appendChild(card);
  });

  list.querySelectorAll('.rem-toggle').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const rems = await api.getReminders();
      const r = rems.find((x) => x.id === cb.dataset.id);
      if (!r) return;
      await api.setReminder({ ...r, enabled: cb.checked });
      toast(cb.checked ? 'Reminder enabled' : 'Reminder disabled');
    });
  });

  list.querySelectorAll('.rem-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.deleteReminder(btn.dataset.id);
      const reminders = await api.getReminders();
      renderReminders(reminders);
      toast('Reminder deleted');
    });
  });
}

$('#rem-add-btn').addEventListener('click', () => {
  const form = $('#rem-add-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) $('#rem-time').focus();
});

$('#rem-cancel').addEventListener('click', () => {
  $('#rem-add-form').classList.add('hidden');
  $('#rem-time').value = '';
  $('#rem-message').value = '';
});

$('#rem-save').addEventListener('click', async () => {
  const time = $('#rem-time').value;
  const message = $('#rem-message').value.trim();
  if (!time) { toast('Please set a time', true); return; }
  if (!message) { toast('Please enter a message', true); return; }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  await api.setReminder({ id, time, message, enabled: true });
  $('#rem-add-form').classList.add('hidden');
  $('#rem-time').value = '';
  $('#rem-message').value = '';
  const reminders = await api.getReminders();
  renderReminders(reminders);
  toast('Reminder saved');
});

// ---------- habits ----------
const HAB_EMOJIS = ['📚', '🏋️', '💧', '🧘', '🏃', '🍎', '💤', '🧹', '✍️', '🎸', '💊', '🌱', '🧠', '☀️', '💰', '📝', '🚭', '🦷'];
const HAB_COLORS = ['#2e9bff', '#a78bfa', '#34d399', '#f5a623', '#f472b6', '#38bdf8', '#fb7185', '#facc15'];

// per-unit slider config (range, step, suffix)
const UNIT_CFG = {
  count:   { min: 0, max: 20,  step: 1, suffix: '×', noun: 'Times' },
  minutes: { min: 0, max: 240, step: 5, suffix: 'm', noun: 'Minutes' },
  custom:  { min: 0, max: 100, step: 1, suffix: '',  noun: 'Amount' }
};

let habitLevels = {};   // id -> last seen level (to detect level-ups after a log)
let editingHabitId = null;
const habForm = { emoji: HAB_EMOJIS[0], color: HAB_COLORS[0], freq: 'daily', unit: 'count', customUnit: '' };

async function loadHabits() {
  const habits = await api.getHabits();
  habits.forEach((h) => { if (habitLevels[h.id] == null) habitLevels[h.id] = h.level; });
  renderHabitSummary(habits);
  renderHabitList(habits);
}

function unitStep(h) { return h.unit === 'minutes' ? 5 : 1; }
function customUnitLabel(h) { return (h.unit === 'custom' && h.customUnit) ? h.customUnit : (h.unit === 'minutes' ? 'min' : '×'); }
function ringLabel(h) {
  if (h.unit === 'minutes') return `Log +${unitStep(h)} min`;
  if (h.unit === 'custom') return `Log +1 ${customUnitLabel(h)}`;
  return 'Log +1';
}
function pad2(n) { return String(n).padStart(2, '0'); }

function renderHabitSummary(habits) {
  $('#hab-s-count').textContent = habits.length;
  $('#hab-s-done').textContent = habits.filter((h) => h.periodDone).length;
  $('#hab-s-streak').textContent = habits.reduce((m, h) => Math.max(m, h.streak), 0);
  $('#hab-s-level').textContent = habits.reduce((s, h) => s + h.level, 0);
}

function freqLabel(h) {
  if (h.trackOnly) return 'Track only';
  const per = h.freqType === 'weekly' ? 'week' : 'day';
  if (h.unit === 'minutes') return `${h.target} min / ${per}`;
  if (h.unit === 'custom') return `${h.target} ${customUnitLabel(h)} / ${per}`;
  return `${h.target}× per ${per}`;
}

function historyStrip(h) {
  const todayK = rendDateKey(new Date());
  const u = h.unit === 'minutes' ? 'm' : h.unit === 'custom' ? ` ${customUnitLabel(h)}` : '×';
  return h.history.map((d) => {
    let cls = 'hh-cell';
    if (d.paused) cls += ' paused';
    else if (d.met) cls += ' met';
    else if (d.frozen) cls += ' frozen';
    else if (d.count > 0) cls += ' partial';
    if (d.date === todayK) cls += ' today';
    const tip = d.paused ? `${d.date}: ⏸ paused` : d.frozen ? `${d.date}: 🧊 frozen` : `${d.date}: ${d.count}${u}`;
    return `<div class="${cls}" title="${tip}"></div>`;
  }).join('');
}

function habitCard(h) {
  const pct = Math.min(100, Math.round((h.periodCount / h.periodTarget) * 100));
  const xpPct = Math.min(100, Math.round((h.xpInto / h.xpForNext) * 100));
  const periodWord = h.freqType === 'weekly'
    ? (h.streak === 1 ? 'week' : 'weeks')
    : (h.streak === 1 ? 'day' : 'days');
  const subUnit = h.unit === 'minutes' ? 'm' : h.unit === 'custom' ? ` ${customUnitLabel(h)}` : '';
  const ringInner = h.trackOnly
    ? (h.periodCount > 0
        ? '<span class="ring-check">✓</span>'
        : `<span class="ring-count">${h.periodCount}${subUnit}</span>`)
    : h.periodDone
      ? '<span class="ring-check">✓</span>'
      : `<span class="ring-count">${h.periodCount}</span><span class="ring-sub">/ ${h.periodTarget}${subUnit}</span>`;
  const streakCls = h.streak > 0 ? 'streak-tag hot' : 'streak-tag cold';
  const peak = (h.peakHour >= 0 && h.entryCount >= 3)
    ? `<span class="hab-peak" title="When you usually log this">🕐 usually ${pad2(h.peakHour)}:00</span>` : '';
  const defAmt = h.unit === 'minutes' ? Math.min(h.target, 30) : 1;
  const stepAttr = h.unit === 'minutes' ? 5 : 1;
  const hlpUnit = h.unit === 'minutes' ? 'min' : h.unit === 'custom' ? customUnitLabel(h) : '×';

  const pausePeriodWord = h.freqType === 'weekly' ? 'week' : 'day';
  const pauseTitle = h.paused ? `Resume — currently paused this ${pausePeriodWord}` : `Pause this ${pausePeriodWord} (doesn't break your streak)`;

  const card = document.createElement('div');
  card.className = 'habit-card' + (h.periodDone ? ' done' : '') + (h.paused ? ' paused' : '');
  card.style.setProperty('--hc', h.color || '#2e9bff');
  card.dataset.id = h.id;
  card.innerHTML = `
    <div class="habit-main">
      <div class="habit-emoji">${escapeHtml(h.emoji)}</div>
      <div class="habit-body">
        <div class="habit-top">
          <div class="habit-name">${escapeHtml(h.name)}</div>
          <div class="habit-tools">
            <span class="level-badge">★ Lv ${h.level}</span>
            <button class="hab-icon-btn hab-pause${h.paused ? ' active' : ''}" title="${pauseTitle}">${h.paused ? '▶' : '⏸'}</button>
            <button class="hab-icon-btn hab-edit" title="Edit habit">✎</button>
            <button class="hab-icon-btn del hab-del" title="Delete habit">✕</button>
          </div>
        </div>
        <div class="habit-meta">
          <span class="freq-tag">${freqLabel(h)}</span>
          <span class="${streakCls}"><span class="fl">🔥</span> ${h.streak} ${periodWord} streak</span>
          <span class="subtle small">· best ${h.bestStreak}</span>
          <span class="freeze-tag${h.freezers === 0 ? ' empty' : ''}" title="${h.freezers} freeze ${h.freqType === 'weekly' ? 'week' : 'day'}${h.freezers !== 1 ? 's' : ''} available">🧊 ${h.freezers}</span>
          ${h.paused ? `<span class="paused-tag" title="This ${pausePeriodWord} is paused — won't count against your streak">⏸ paused</span>` : ''}
          ${peak}
        </div>
        <div class="xp-bar"><div class="xp-fill" data-w="${xpPct}"></div></div>
        <div class="xp-text">${h.xpInto} / ${h.xpForNext} XP → Lv ${h.level + 1}</div>
      </div>
      <div class="habit-ring-wrap">
        <button class="habit-ring hab-log" style="--pct:0" data-pct="${pct}" title="${ringLabel(h)}">
          <span class="ring-inner">${ringInner}</span>
        </button>
        <div class="ring-btns">
          <button class="ring-undo hab-undo" title="Undo" ${h.todayCount > 0 ? '' : 'disabled'}>−</button>
          <button class="ring-more hab-more" title="Log a custom amount or backdate">＋…</button>
        </div>
      </div>
    </div>
    <div class="hab-log-panel hidden">
      <div class="hlp-row">
        <label class="hlp-lbl">Amount</label>
        <input type="number" class="hlp-amt" min="1" step="${stepAttr}" value="${defAmt}" />
        <span class="hlp-unit">${hlpUnit}</span>
      </div>
      <div class="hlp-row">
        <label class="hlp-lbl">When</label>
        <input type="date" class="hlp-date time-input" />
        <input type="time" class="hlp-time time-input" />
      </div>
      <div class="hlp-actions">
        <button class="btn ghost hlp-cancel">Cancel</button>
        <button class="btn primary hlp-add">Add entry</button>
      </div>
    </div>
    <div class="habit-history">${historyStrip(h)}</div>`;

  const step = unitStep(h);
  card.querySelector('.hab-log').addEventListener('click', () => doLogHabit(h.id, step, card));
  card.querySelector('.hab-undo').addEventListener('click', () => doLogHabit(h.id, -step, card));
  card.querySelector('.hab-edit').addEventListener('click', () => openHabitForm(h));
  card.querySelector('.hab-del').addEventListener('click', () => deleteHabitConfirmed(h.id));
  card.querySelector('.hab-pause').addEventListener('click', () => doPauseHabit(h.id));
  wireLogPanel(card, h);
  return card;
}

// inline panel for logging a custom amount on a chosen day & time (for backdating/stats)
function wireLogPanel(card, h) {
  const panel = card.querySelector('.hab-log-panel');
  const dateEl = card.querySelector('.hlp-date');
  const timeEl = card.querySelector('.hlp-time');
  card.querySelector('.hab-more').addEventListener('click', () => {
    const open = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    if (open) {
      const now = new Date();
      dateEl.value = rendDateKey(now);
      timeEl.value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      dateEl.max = rendDateKey(now); // no future entries
    }
  });
  card.querySelector('.hlp-cancel').addEventListener('click', () => panel.classList.add('hidden'));
  card.querySelector('.hlp-add').addEventListener('click', () => {
    const amount = parseInt(card.querySelector('.hlp-amt').value, 10);
    if (!amount || amount <= 0) { toast('Enter an amount', true); return; }
    const date = dateEl.value;
    if (!date) { toast('Pick a day', true); return; }
    doLogHabit(h.id, amount, card, { date, time: timeEl.value || '12:00' });
  });
}

// Run the ring & XP bar from 0 to their target so they sweep in (on load and on log).
function animateFills(scope) {
  scope.querySelectorAll('.habit-ring').forEach((r) => r.style.setProperty('--pct', r.dataset.pct));
  scope.querySelectorAll('.xp-fill').forEach((f) => { f.style.width = f.dataset.w + '%'; });
}

function renderHabitList(habits) {
  const list = $('#hab-list');
  if (!habits.length) {
    list.innerHTML = '<div class="habits-empty">No habits yet — click &ldquo;+ New Habit&rdquo; to start building one 🌱</div>';
    return;
  }
  list.innerHTML = '';
  habits.forEach((h) => list.appendChild(habitCard(h)));
  requestAnimationFrame(() => animateFills(list));
}

async function doLogHabit(id, amount, card, when) {
  const updated = await api.logHabit(id, amount, when || null);
  if (!updated) return;

  const prevLevel = habitLevels[id] != null ? habitLevels[id] : updated.level;
  const leveledUp = updated.level > prevLevel;
  habitLevels[id] = updated.level;

  const fresh = habitCard(updated);
  card.replaceWith(fresh);
  requestAnimationFrame(() => {
    animateFills(fresh);
    if (amount > 0) fresh.querySelector('.habit-ring').classList.add('pop');
  });
  if (updated.periodDone && amount > 0) fresh.classList.add('burst');
  if (leveledUp) celebrateLevelUp(updated);
  if (when) toast('Entry added');

  const all = await api.getHabits();
  renderHabitSummary(all);
}

async function doPauseHabit(id) {
  const updated = await api.pauseHabit(id);
  if (!updated) return;
  toast(updated.paused ? 'Paused — streak protected' : 'Resumed');
  loadHabits();
}

async function deleteHabitConfirmed(id) {
  await api.deleteHabit(id);
  delete habitLevels[id];
  loadHabits();
  toast('Habit deleted');
}

// ---- level-up celebration ----
function celebrateLevelUp(h) {
  $('#levelup-emoji').textContent = h.emoji || '🎉';
  $('#levelup-sub').textContent = `${h.name} reached level ${h.level}`;
  const overlay = $('#levelup');
  overlay.classList.remove('hidden', 'hide');
  spawnConfetti();
  clearTimeout(overlay._t);
  overlay._t = setTimeout(() => {
    overlay.classList.add('hide');
    setTimeout(() => overlay.classList.add('hidden'), 300);
  }, 1900);
}

function spawnConfetti() {
  const box = $('#levelup-confetti');
  box.innerHTML = '';
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + '%';
    p.style.background = HAB_COLORS[i % HAB_COLORS.length];
    p.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
    box.appendChild(p);
  }
}

// ---- add / edit form ----
function buildHabitPickers() {
  const ep = $('#hab-emoji-picker');
  ep.innerHTML = '';
  HAB_EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-opt';
    b.textContent = e;
    b.addEventListener('click', () => { habForm.emoji = e; syncHabitForm(); });
    ep.appendChild(b);
  });
  const cp = $('#hab-color-picker');
  cp.innerHTML = '';
  HAB_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-opt';
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener('click', () => { habForm.color = c; syncHabitForm(); });
    cp.appendChild(b);
  });
}

// Re-range the target slider to the current unit and snap the value into bounds.
function applyUnitToSlider() {
  const cfg = UNIT_CFG[habForm.unit];
  const t = $('#hab-target');
  const cur = parseInt(t.value, 10) || cfg.min;
  t.min = cfg.min; t.max = cfg.max; t.step = cfg.step;
  let v = Math.min(cfg.max, Math.max(cfg.min, cur));
  v = Math.round(v / cfg.step) * cfg.step;
  t.value = v;
}

function targetText() {
  const val = parseInt($('#hab-target').value, 10);
  if (val === 0) return 'No target';
  if (habForm.unit === 'custom') return val + (habForm.customUnit ? ` ${habForm.customUnit}` : '');
  return val + UNIT_CFG[habForm.unit].suffix;
}

function syncHabitForm() {
  $$('#hab-emoji-picker .emoji-opt').forEach((b) => b.classList.toggle('sel', b.textContent === habForm.emoji));
  $$('#hab-color-picker .color-opt').forEach((b) => b.classList.toggle('sel', b.dataset.color === habForm.color));
  $$('#hab-freq-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.freq === habForm.freq));
  $$('#hab-unit-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.unit === habForm.unit));
  const isCustom = habForm.unit === 'custom';
  $('#hab-custom-unit-row').classList.toggle('hidden', !isCustom);
  const per = habForm.freq === 'weekly' ? 'week' : 'day';
  const isZero = parseInt($('#hab-target').value, 10) === 0;
  const noun = isZero ? 'Track only — no goal' : isCustom ? (habForm.customUnit || 'Amount') : UNIT_CFG[habForm.unit].noun;
  $('#hab-target-hint').textContent = isZero ? noun : `${noun} per ${per}`;
  $('#hab-target-val').textContent = targetText();
}

function openHabitForm(habit) {
  editingHabitId = habit ? habit.id : null;
  $('#hab-form-title').textContent = habit ? 'Edit Habit' : 'New Habit';
  $('#hab-save').textContent = habit ? 'Save Changes' : 'Save Habit';
  $('#hab-name').value = habit ? habit.name : '';
  habForm.emoji = habit ? habit.emoji : HAB_EMOJIS[0];
  habForm.color = habit ? habit.color : HAB_COLORS[0];
  habForm.freq = habit ? habit.freqType : 'daily';
  habForm.unit = habit ? habit.unit : 'count';
  habForm.customUnit = (habit && habit.unit === 'custom') ? (habit.customUnit || '') : '';
  $('#hab-custom-unit').value = habForm.customUnit;
  applyUnitToSlider();
  $('#hab-target').value = habit ? habit.target : (habForm.unit === 'minutes' ? 30 : 1);
  syncHabitForm();
  $('#hab-form').classList.remove('hidden');
  $('#hab-name').focus();
  $('#hab-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$$('#hab-freq-seg .seg-btn').forEach((b) => b.addEventListener('click', () => { habForm.freq = b.dataset.freq; syncHabitForm(); }));
$$('#hab-unit-seg .seg-btn').forEach((b) => b.addEventListener('click', () => { habForm.unit = b.dataset.unit; applyUnitToSlider(); syncHabitForm(); }));
$('#hab-target').addEventListener('input', () => { $('#hab-target-val').textContent = targetText(); syncHabitForm(); });
$('#hab-custom-unit').addEventListener('input', () => { habForm.customUnit = $('#hab-custom-unit').value; syncHabitForm(); });

$('#hab-add-btn').addEventListener('click', () => {
  const form = $('#hab-form');
  if (form.classList.contains('hidden')) openHabitForm(null);
  else { form.classList.add('hidden'); editingHabitId = null; }
});
$('#hab-cancel').addEventListener('click', () => { $('#hab-form').classList.add('hidden'); editingHabitId = null; });

$('#hab-save').addEventListener('click', async () => {
  const name = $('#hab-name').value.trim();
  if (!name) { toast('Please name the habit', true); return; }
  if (habForm.unit === 'custom' && !habForm.customUnit.trim()) {
    toast('Please enter a unit name', true); return;
  }
  const payload = {
    name,
    emoji: habForm.emoji,
    color: habForm.color,
    freqType: habForm.freq,
    unit: habForm.unit,
    customUnit: habForm.unit === 'custom' ? habForm.customUnit.trim() : undefined,
    target: parseInt($('#hab-target').value, 10)
  };
  if (editingHabitId) { await api.updateHabit(editingHabitId, payload); toast('Habit updated'); }
  else { await api.addHabit(payload); toast('Habit created 🌱'); }
  $('#hab-form').classList.add('hidden');
  editingHabitId = null;
  loadHabits();
});

// ---------- live updates ----------
api.onTick((p) => {
  // keep the hero counter & current app fresh without a full reload
  if (!$('#page-dashboard').classList.contains('hidden') && dashRange === 'Today' && dashOffset === 0) {
    $('#hero-time').innerHTML = fmtLong(p.todaySeconds);
  }
  $('#hero-current-app').textContent = p.currentApp || '—';
  if (p.session) {
    $('#sess-apps').textContent = p.session.apps;
    $('#sess-focus').textContent = p.session.focus + '%';
  }
  lastIdleSeconds = p.idleSecs || 0;
  applyTrackingUI(trackingOn, p.idle, p.idleSecs);
});
api.onTrackingChanged((d) => { trackingOn = d.tracking; applyTrackingUI(d.tracking, false); const cb = $('#set-tracking'); if (cb) cb.checked = d.tracking; });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- boot ----------
buildHabitPickers();
go('dashboard');
api.getSettings().then((s) => { applyStudyUI(!!s.studyMode); applyNotMeUI(!!s.notMe); });
setInterval(() => { if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard(); }, 30000);

})();
