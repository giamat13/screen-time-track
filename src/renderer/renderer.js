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
let trackingOn = true;
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
      if (scope === 'dashboard') { dashRange = tab.dataset.range; loadDashboard(); }
      else { statsRange = tab.dataset.range; loadStats(); }
    });
  });
});
$('#refresh-btn').addEventListener('click', () => loadDashboard());
$('#hero-pause').addEventListener('click', async () => {
  const tracking = await api.toggleTracking();
  applyTrackingUI(tracking);
});

// ---------- dashboard ----------
async function loadDashboard() {
  const d = await api.getDashboard(dashRange);
  $('#greeting').textContent = timeOfDay();
  $('#today-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  $('#hero-label').textContent = dashRange === 'Today' ? "Today's Screen Time" : `Screen Time (${labelFor(dashRange)})`;
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
  const d = await api.getStats(statsRange);
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

// ---------- settings ----------
async function loadSettings() {
  const s = await api.getSettings();
  $('#set-tracking').checked = !!s.tracking;
  $('#set-autolaunch').checked = !!s.autoLaunch;
  $('#set-tray').checked = !!s.minimizeToTray;
  $('#set-blocking').checked = !!s.blockingEnabled;
  $('#set-idle').value = String(s.idleThreshold || 120);
  $('#set-interval').value = String(s.pollInterval || 2);
}
$('#set-tracking').addEventListener('change', async (e) => { await api.setTracking(e.target.checked); });
$('#set-autolaunch').addEventListener('change', (e) => api.setSettings({ autoLaunch: e.target.checked }));
$('#set-tray').addEventListener('change', (e) => api.setSettings({ minimizeToTray: e.target.checked }));
$('#set-idle').addEventListener('change', (e) => api.setSettings({ idleThreshold: parseInt(e.target.value, 10) }));
$('#set-interval').addEventListener('change', (e) => { api.setSettings({ pollInterval: parseInt(e.target.value, 10) }); toast('Restart to apply new interval'); });
$('#set-reset').addEventListener('click', async () => { await api.resetSession(); toast('Session reset'); if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard(); });

// ---------- break reminder ----------
async function loadBreaks() {
  const s = await api.getSettings();
  brkSettings = Object.assign({
    enabled: false, checkIntervalMinutes: 75,
    beepFrequency: 1000, beepDuration: 200, beepIntervalSeconds: 0.4
  }, s.breakReminder || {});

  $('#brk-enabled').checked = !!brkSettings.enabled;
  $('#brk-interval').value = brkSettings.checkIntervalMinutes;
  $('#brk-freq').value = brkSettings.beepFrequency;
  $('#brk-dur').value = brkSettings.beepDuration;
  $('#brk-beep-int').value = brkSettings.beepIntervalSeconds;
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
    $('#brk-status-sub').textContent = 'Get up! Take a break — the alarm will stop when you leave the computer';
    return;
  }
  if (status.nextCheckAt) {
    const mins = Math.max(0, Math.round((status.nextCheckAt - Date.now()) / 60000));
    $('#brk-status-title').textContent = `Next reminder in ${mins}m`;
    $('#brk-status-sub').textContent = 'Will only ring if you\'re at the computer during the check';
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
  $('#brk-freq-val').textContent = `${$('#brk-freq').value} Hz`;
  $('#brk-dur-val').textContent = `${$('#brk-dur').value}ms`;
  $('#brk-beep-int-val').textContent = `${parseFloat($('#brk-beep-int').value).toFixed(1)}s`;
}

async function saveBrkSettings() {
  brkSettings = {
    enabled: $('#brk-enabled').checked,
    checkIntervalMinutes: parseInt($('#brk-interval').value),
    beepFrequency: parseInt($('#brk-freq').value),
    beepDuration: parseInt($('#brk-dur').value),
    beepIntervalSeconds: parseFloat($('#brk-beep-int').value),
  };
  await api.setSettings({ breakReminder: brkSettings });
  await updateBrkStatus();
}

$('#brk-enabled').addEventListener('change', saveBrkSettings);
$('#brk-test').addEventListener('click', () => api.testBreak());
['brk-interval', 'brk-freq', 'brk-dur', 'brk-beep-int'].forEach((id) => {
  const el = $(`#${id}`);
  el.addEventListener('input', updateBrkLabels);
  el.addEventListener('change', saveBrkSettings);
});

// ---------- live updates ----------
api.onTick((p) => {
  // keep the hero counter & current app fresh without a full reload
  if (!$('#page-dashboard').classList.contains('hidden') && dashRange === 'Today') {
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
go('dashboard');
setInterval(() => { if (!$('#page-dashboard').classList.contains('hidden')) loadDashboard(); }, 30000);

})();
