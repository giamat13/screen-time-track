// Persistent data store (JSON file in userData). Aggregates time per day per app.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(app.getPath('userData'), 'screen-time-data.json');

function defaults() {
  return {
    version: 1,
    installedAt: new Date().toISOString(),
    days: {}, // 'YYYY-MM-DD' -> { apps: { name: seconds }, total, firstSeen, lastSeen }
    goals: {}, // { appName: targetSeconds }
    globalLimit: 0, // total daily screen-time cap across all apps (seconds); 0 = off
    goalsSnapshots: [], // [{ effectiveDate: 'YYYY-MM-DD', goals: {...}, globalLimit: N }]
    reminders: [], // [{ id, time: 'HH:MM', message, enabled }]
    habits: [], // [{ id, name, emoji, color, freqType: 'daily'|'weekly', target, createdAt, log: { 'YYYY-MM-DD': count } }]
    streaks: { current: 0, best: 0, lastCheckedDate: null, metDays: {}, freezers: 5, frozenDays: {} },
    settings: {
      tracking: true,
      idleThreshold: 120, // seconds with no input => not counted
      pollInterval: 2, // seconds between samples
      autoLaunch: true,
      minimizeToTray: true,
      studyMode: false, // when on, time is still tracked but excluded from daily limits
      browserDetail: true, // relabel browser time to the real site via the extension
      countMediaWhenIdle: true, // keep counting while a video/track is playing
      mediaIdleCap: 600, // after this many idle seconds, stop counting media (you left)
      breakReminder: {
        enabled: false,
        checkIntervalMinutes: 60,
        devMode: false,             // use a seconds-based interval for quick testing
        checkIntervalSeconds: 10,   // interval used when devMode is on
        beepFrequency: 1000,
        beepDuration: 200,
        beepIntervalSeconds: 0.4,
      }
    }
  };
}

let data = defaults();
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data = Object.assign(defaults(), parsed);
      data.settings = Object.assign(defaults().settings, parsed.settings || {});
      if (parsed.settings?.breakReminder) {
        data.settings.breakReminder = Object.assign(defaults().settings.breakReminder, parsed.settings.breakReminder);
      }
      data.days = parsed.days || {};
      data.goals = parsed.goals || {};
      data.globalLimit = parsed.globalLimit || 0;
      data.goalsSnapshots = parsed.goalsSnapshots || [];
      // Migrate: if no snapshots exist yet, seed one from the current goals.
      // Use today as the effectiveDate so past days without goals aren't counted.
      if (!data.goalsSnapshots.length && (Object.keys(data.goals).length || data.globalLimit)) {
        data.goalsSnapshots = [{ effectiveDate: dateKey(), goals: Object.assign({}, data.goals), globalLimit: data.globalLimit || 0 }];
      }
      // One-time fix: old migration used installedAt as effectiveDate, which retroactively
      // applied goals to days before they were set and inflated the streak.
      // Detect the pattern: single snapshot whose date matches installedAt (not today).
      if (
        data.goalsSnapshots.length === 1 &&
        data.installedAt &&
        data.goalsSnapshots[0].effectiveDate === data.installedAt.split('T')[0] &&
        data.goalsSnapshots[0].effectiveDate < dateKey()
      ) {
        data.goalsSnapshots[0].effectiveDate = dateKey();
        data.streaks = defaults().streaks;
      }
      data.reminders = parsed.reminders || [];
      data.habits = parsed.habits || [];
      if (parsed.streaks) {
        data.streaks = Object.assign(defaults().streaks, parsed.streaks);
        data.streaks.metDays = parsed.streaks.metDays || {};
        data.streaks.frozenDays = parsed.streaks.frozenDays || {};
      }
    }
  } catch (e) {
    console.error('[store] load failed:', e.message);
    data = defaults();
  }
  return data;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 4000);
}

function flush() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDay(key) {
  if (!data.days[key]) {
    const now = new Date().toISOString();
    data.days[key] = { apps: {}, total: 0, firstSeen: now, lastSeen: now, hours: new Array(24).fill(0), studyApps: {}, study: 0 };
  }
  // Backfill buckets for days created before those features existed.
  if (!Array.isArray(data.days[key].hours)) data.days[key].hours = new Array(24).fill(0);
  if (!data.days[key].studyApps) data.days[key].studyApps = {};
  if (typeof data.days[key].study !== 'number') data.days[key].study = 0;
  return data.days[key];
}

// `isStudy` time still counts toward the displayed totals, but is tracked in a
// parallel bucket so it can be excluded from daily limits / streak checks.
function addTime(appName, seconds, isStudy = false) {
  if (!appName || seconds <= 0) return;
  const day = ensureDay(dateKey());
  day.apps[appName] = (day.apps[appName] || 0) + seconds;
  day.total += seconds;
  day.hours[new Date().getHours()] += seconds;
  if (isStudy) {
    day.studyApps[appName] = (day.studyApps[appName] || 0) + seconds;
    day.study += seconds;
  }
  day.lastSeen = new Date().toISOString();
  scheduleSave();
}

function getToday() {
  return ensureDay(dateKey());
}

// Aggregate a window of `days` days. `endOffset` shifts the window back in time:
// 0 = window ends today, 7 = window ends 7 days ago, etc. (used by date navigation).
function rangeData(days, endOffset = 0) {
  const result = { apps: {}, total: 0, perDay: [], daysWithData: 0, hours: new Array(24).fill(0), studyApps: {}, study: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i - endOffset);
    const key = dateKey(d);
    const day = data.days[key];
    const total = day ? day.total : 0;
    result.perDay.push({ date: key, total });
    if (day && day.total > 0) {
      result.daysWithData++;
      for (const [a, s] of Object.entries(day.apps)) result.apps[a] = (result.apps[a] || 0) + s;
      if (Array.isArray(day.hours)) for (let h = 0; h < 24; h++) result.hours[h] += day.hours[h] || 0;
      if (day.studyApps) for (const [a, s] of Object.entries(day.studyApps)) result.studyApps[a] = (result.studyApps[a] || 0) + s;
      result.study += day.study || 0;
      result.total += day.total;
    }
  }
  return result;
}

// Average screen time per day-of-week over the last `lookback` days.
// Returns 7 entries (Sun..Sat) with avg seconds; flags the lowest non-empty day.
function dayOfWeekStats(lookback = 30) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (let i = 0; i < lookback; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = data.days[dateKey(d)];
    if (day && day.total > 0) {
      sums[d.getDay()] += day.total;
      counts[d.getDay()]++;
    }
  }
  const week = sums.map((s, i) => ({ dow: i, avg: counts[i] ? Math.round(s / counts[i]) : 0, days: counts[i] }));
  const active = week.filter((w) => w.days > 0);
  let lowest = null, highest = null;
  if (active.length) {
    lowest = active.reduce((m, w) => (w.avg < m.avg ? w : m));
    highest = active.reduce((m, w) => (w.avg > m.avg ? w : m));
  }
  return { week, lowest, highest };
}

// Compare the average of the last 7 days against the 7 before that.
function trendAnalysis() {
  const recent = rangeData(7, 0);
  const prior = rangeData(7, 7);
  const recentAvg = recent.daysWithData ? recent.total / recent.daysWithData : 0;
  const priorAvg = prior.daysWithData ? prior.total / prior.daysWithData : 0;
  let pct;
  if (priorAvg > 0) pct = Math.round(((recentAvg - priorAvg) / priorAvg) * 100);
  else pct = recentAvg > 0 ? 100 : 0;
  return {
    recentAvg: Math.round(recentAvg),
    priorAvg: Math.round(priorAvg),
    pct,
    direction: pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat'
  };
}

function dayTotal(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const day = data.days[dateKey(d)];
  return day ? day.total : 0;
}

function getGoals() { return data.goals || {}; }

// Record current goals + globalLimit as a snapshot effective today.
// If today already has a snapshot, update it in place.
function recordGoalsSnapshot() {
  if (!data.goalsSnapshots) data.goalsSnapshots = [];
  const today = dateKey();
  const existing = data.goalsSnapshots.find((s) => s.effectiveDate === today);
  if (existing) {
    existing.goals = Object.assign({}, data.goals);
    existing.globalLimit = data.globalLimit || 0;
  } else {
    data.goalsSnapshots.push({ effectiveDate: today, goals: Object.assign({}, data.goals), globalLimit: data.globalLimit || 0 });
  }
}

// Return the goals and globalLimit that were in effect on a given day.
function getGoalsForDate(key) {
  const snapshots = data.goalsSnapshots || [];
  const applicable = snapshots
    .filter((s) => s.effectiveDate <= key)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  if (applicable) return { goals: applicable.goals || {}, globalLimit: applicable.globalLimit || 0 };
  // No snapshot predates this key — no goals were active
  return { goals: {}, globalLimit: 0 };
}

function setGoal(appName, targetSeconds) {
  if (!data.goals) data.goals = {};
  if (!targetSeconds || targetSeconds <= 0) {
    delete data.goals[appName];
  } else {
    data.goals[appName] = Math.round(targetSeconds);
  }
  recordGoalsSnapshot();
  flush();
  return data.goals;
}

function checkGoalsMet(key) {
  const { goals, globalLimit } = getGoalsForDate(key);
  if (Object.keys(goals).length === 0 && !globalLimit) return null; // nothing to enforce
  const day = data.days[key];
  if (!day) return null; // no tracking that day => neutral, doesn't count toward the streak
  const studyApps = day.studyApps || {};
  const playTotal = day.total - (day.study || 0); // study time doesn't count against limits
  if (globalLimit && playTotal > globalLimit) return false; // total screen time exceeded
  for (const [appName, targetSec] of Object.entries(goals)) {
    const actual = ((day.apps && day.apps[appName]) || 0) - (studyApps[appName] || 0);
    if (actual > targetSec) return false; // exceeded limit
  }
  return true;
}

// Streaks start with 5 freezers and earn another every 3 met days. When a day is
// missed, a freezer is spent to keep the streak alive (the streak drops by one
// instead of resetting).
const FREEZER_EVERY = 3;
const STARTING_FREEZERS = 5;

function syncStreaks() {
  if (!data.streaks) data.streaks = defaults().streaks;
  if (!data.streaks.metDays) data.streaks.metDays = {};
  const today = dateKey();
  const goals = data.goals || {};
  // Habits now feed the same streak as screen-time goals, so the streak is active when
  // either is configured.
  const active = Object.keys(goals).length > 0 || (data.globalLimit || 0) > 0 || habitsConfigured();
  if (active) {
    // Re-evaluate the last 30 days so the calendar stays current
    for (let i = 30; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      data.streaks.metDays[dateKey(d)] = checkDayMet(dateKey(d));
    }
  }

  // Trim metDays to a 90-day rolling window so stale entries from old goals/habits
  // don't inflate the streak or best count.
  const cutoff = dateKey(new Date(Date.now() - 90 * 86400000));
  for (const k of Object.keys(data.streaks.metDays)) {
    if (k < cutoff) delete data.streaks.metDays[k];
  }

  // Forward-simulate from the oldest evaluated day to today so freezers
  // accrue and get spent deterministically.
  const keys = Object.keys(data.streaks.metDays).sort();
  let streak = 0, freezers = STARTING_FREEZERS, best = 0;
  const frozen = {};
  for (const k of keys) {
    const met = data.streaks.metDays[k];
    if (met === true) {
      streak++;
      if (streak % FREEZER_EVERY === 0) freezers++;
    } else if (met === false) {
      if (freezers > 0) {
        freezers--;
        frozen[k] = true;
        // freezer saves the streak and leaves the current count intact
      } else {
        streak = 0;
        freezers = 0;
      }
    }
    // null/undefined => neutral day, leaves the streak untouched
    if (streak > best) best = streak;
  }

  data.streaks.current = streak;
  data.streaks.freezers = freezers;
  data.streaks.frozenDays = frozen;
  data.streaks.best = best;
  data.streaks.lastCheckedDate = today;
}

function getGlobalLimit() { return data.globalLimit || 0; }

function setGlobalLimit(seconds) {
  data.globalLimit = (!seconds || seconds <= 0) ? 0 : Math.round(seconds);
  recordGoalsSnapshot();
  flush();
  return data.globalLimit;
}

function getStreaks() {
  syncStreaks();
  scheduleSave();
  return data.streaks;
}

function weeklyReport() {
  syncStreaks();
  const result = { days: [], total: 0, apps: {}, prevWeekTotal: 0 };
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const day = data.days[key];
    const dayTotal = day ? day.total : 0;
    const apps = day ? (day.apps || {}) : {};
    const goalMet = (data.streaks.metDays && data.streaks.metDays[key]) ?? null;
    result.days.push({ date: key, total: dayTotal, apps, goalMet });
    result.total += dayTotal;
    for (const [a, s] of Object.entries(apps)) result.apps[a] = (result.apps[a] || 0) + s;
  }
  for (let i = 13; i >= 7; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = data.days[dateKey(d)];
    result.prevWeekTotal += day ? day.total : 0;
  }
  return result;
}

function getReminders() { return data.reminders || []; }

function setReminder(r) {
  if (!data.reminders) data.reminders = [];
  const idx = data.reminders.findIndex((x) => x.id === r.id);
  if (idx >= 0) data.reminders[idx] = r;
  else data.reminders.push(r);
  flush();
  return data.reminders;
}

function deleteReminder(id) {
  data.reminders = (data.reminders || []).filter((r) => r.id !== id);
  flush();
  return data.reminders;
}

// ---------- habits ----------
// Habits are user-defined recurring actions, measured either by count ("Drink water
// 8×/day") or by time ("Read 30 min/day"). Every completion is stored as a timestamped
// entry; the daily/weekly aggregates, streaks, XP, levels and hour-of-day stats are all
// derived from those entries so nothing can drift out of sync. Manual entries can be
// backdated to a chosen day & time, which feeds both the per-habit and main streak.
const HABIT_XP_PER_UNIT = { count: 10, minutes: 1, custom: 10 };
const HABIT_TARGET_MAX = { count: 50, minutes: 1440, custom: 100 };
const HABIT_FREEZERS_START = 3;   // each habit starts with this many freeze periods
const HABIT_FREEZER_EVERY  = 7;   // earn one more freeze period every N consecutive met periods

// Cumulative XP needed grows by a fixed step each level, giving a gentle ramp:
// L2 @ 50xp, L3 @ 125, L4 @ 225, L5 @ 350 …
function levelFromXp(xp) {
  let level = 1, acc = 0, need = 50;
  while (xp >= acc + need) { acc += need; level++; need += 25; }
  return { level, xpInto: xp - acc, xpForNext: need };
}

// Sunday-anchored start of the week containing `d`.
function weekStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

// Longest run of consecutive met periods. `keys` are date strings (day for daily,
// week-start for weekly); `stepDays` is the spacing that counts as "consecutive".
function bestRun(keys, stepDays) {
  const sorted = [...keys].sort();
  let best = 0, cur = 0, prev = null;
  for (const k of sorted) {
    const d = new Date(k + 'T00:00:00');
    if (prev && Math.round((d - prev) / 86400000) === stepDays) cur++;
    else cur = 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

function habitUnit(h) { return h.unit === 'minutes' ? 'minutes' : h.unit === 'custom' ? 'custom' : 'count'; }
function clampTarget(unit, v) { const n = parseInt(v, 10); return isNaN(n) ? 1 : Math.max(0, Math.min(HABIT_TARGET_MAX[unit] || 50, n)); }

// Migrate any legacy day-count `log` into the timestamped `entries` model (one entry
// per day at noon), then return the entries array (the single source of truth).
function habitEntries(h) {
  if (!Array.isArray(h.entries)) {
    const e = [];
    if (h.log && typeof h.log === 'object') {
      for (const [day, amt] of Object.entries(h.log)) {
        if (amt > 0) e.push({ ts: `${day}T12:00:00.000`, amount: amt });
      }
    }
    h.entries = e;
    delete h.log;
  }
  return h.entries;
}

// Sum entries per calendar day -> { 'YYYY-MM-DD': totalAmount }.
function dayMapOf(h) {
  const map = {};
  for (const en of habitEntries(h)) {
    const k = dateKey(new Date(en.ts));
    map[k] = (map[k] || 0) + (en.amount || 0);
  }
  return map;
}

function dailyStreakMap(map, target) {
  let streak = 0;
  for (let i = 0; i < 366; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const c = map[dateKey(d)] || 0;
    if (c >= target) streak++;
    else if (i === 0) continue; // today still in progress — don't break the streak yet
    else break;
  }
  return streak;
}

function weekSumMap(map, ws) {
  let sum = 0;
  for (let j = 0; j < 7; j++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + j);
    sum += map[dateKey(d)] || 0;
  }
  return sum;
}

function weeklyStreakMap(map, target) {
  let streak = 0;
  for (let i = 0; i < 260; i++) {
    const ws = weekStart();
    ws.setDate(ws.getDate() - i * 7);
    if (weekSumMap(map, ws) >= target) streak++;
    else if (i === 0) continue; // current week still in progress
    else break;
  }
  return streak;
}

// Compute streak with per-habit freeze periods (daily or weekly).
// Returns { streak, freezers, frozenPeriods } where frozenPeriods is an array of
// date strings (YYYY-MM-DD) that were saved by a freeze.
// Walks the full history forward so earnings and spends stay consistent.
function calcHabitStreak(map, createdAt, target, weekly) {
  const today = dateKey();
  const created = createdAt ? dateKey(new Date(createdAt)) : today;

  // Build ordered list of periods to evaluate (daily: each day; weekly: each week-start).
  const periods = [];
  if (weekly) {
    const ws0 = weekStart(new Date(created + 'T00:00:00'));
    const wsNow = weekStart();
    for (let cur = new Date(ws0); cur <= wsNow; cur.setDate(cur.getDate() + 7)) {
      periods.push({ key: dateKey(cur), ws: new Date(cur) });
    }
  } else {
    const d = new Date(created + 'T00:00:00');
    const now = new Date();
    while (d <= now) {
      periods.push({ key: dateKey(d) });
      d.setDate(d.getDate() + 1);
    }
  }

  let streak = 0, freezers = HABIT_FREEZERS_START, metRun = 0;
  const frozenPeriods = [];

  for (const p of periods) {
    const isToday = weekly
      ? p.key === dateKey(weekStart())  // current (in-progress) week
      : p.key === today;

    const met = weekly
      ? weekSumMap(map, p.ws) >= target
      : (map[p.key] || 0) >= target;

    if (met) {
      streak++;
      metRun++;
      if (metRun > 0 && metRun % HABIT_FREEZER_EVERY === 0) freezers++;
    } else if (isToday) {
      // current period still in progress — don't penalise
    } else {
      if (freezers > 0) {
        freezers--;
        frozenPeriods.push(p.key);
        // streak continues but no +1 for this period; metRun resets
        metRun = 0;
      } else {
        streak = 0;
        metRun = 0;
        frozenPeriods.length = 0; // discard; old frozen periods pre-date the current streak
      }
    }
  }

  return { streak, freezers, frozenPeriods };
}

// Decorate a stored habit with all derived stats the UI needs.
function enrichHabit(h) {
  const unit = habitUnit(h);
  const target = clampTarget(unit, h.target);
  const trackOnly = target === 0; // no goal — just log freely
  const effectiveTarget = trackOnly ? 1 : target; // for streak/met calculations
  const today = dateKey();
  const weekly = h.freqType === 'weekly';
  const map = dayMapOf(h);
  const entries = habitEntries(h);

  let totalDone = 0;
  for (const v of Object.values(map)) totalDone += v;

  let periodCount, best;
  const { streak, freezers, frozenPeriods } = calcHabitStreak(map, h.createdAt, effectiveTarget, weekly);
  if (weekly) {
    periodCount = weekSumMap(map, weekStart());
    const metWeeks = [];
    for (let i = 0; i < 260; i++) {
      const ws = weekStart();
      ws.setDate(ws.getDate() - i * 7);
      if (weekSumMap(map, ws) >= effectiveTarget) metWeeks.push(dateKey(ws));
    }
    best = bestRun(metWeeks, 7);
  } else {
    periodCount = map[today] || 0;
    best = bestRun(Object.keys(map).filter((k) => map[k] >= effectiveTarget), 1);
  }

  const xp = Math.round(totalDone * HABIT_XP_PER_UNIT[unit]);
  const lvl = levelFromXp(xp);

  // last 14 days of activity for the mini-calendar / heatmap strip
  const history = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dateKey(d);
    const c = map[k] || 0;
    history.push({ date: k, count: c, met: trackOnly ? c > 0 : c >= target, dow: d.getDay() });
  }

  // hour-of-day distribution: when do completions actually happen?
  const hours = new Array(24).fill(0);
  for (const en of entries) hours[new Date(en.ts).getHours()] += en.amount || 0;
  let peakHour = -1, peakVal = 0;
  hours.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakHour = i; } });

  const frozenSet = new Set(frozenPeriods);
  // mark frozen periods in history strip
  const historyWithFreeze = history.map((d) => ({ ...d, frozen: frozenSet.has(d.date) }));

  return {
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    color: h.color,
    freqType: weekly ? 'weekly' : 'daily',
    unit,
    customUnit: h.customUnit,
    target,
    trackOnly,
    createdAt: h.createdAt,
    todayCount: map[today] || 0,
    periodCount,
    periodTarget: target,
    periodDone: trackOnly ? periodCount > 0 : periodCount >= target,
    streak,
    bestStreak: Math.max(best, streak),
    freezers,
    frozenPeriods,
    totalDone,
    entryCount: entries.length,
    xp,
    level: lvl.level,
    xpInto: lvl.xpInto,
    xpForNext: lvl.xpForNext,
    history: historyWithFreeze,
    hours,
    peakHour
  };
}

function getHabits() {
  return (data.habits || []).map(enrichHabit);
}

function addHabit(h) {
  if (!data.habits) data.habits = [];
  const unit = h.unit === 'minutes' ? 'minutes' : h.unit === 'custom' ? 'custom' : 'count';
  const habit = {
    id: h.id || (Date.now().toString(36) + Math.random().toString(36).slice(2)),
    name: (h.name || 'Habit').toString().slice(0, 60),
    emoji: h.emoji || '✅',
    color: h.color || '#2e9bff',
    freqType: h.freqType === 'weekly' ? 'weekly' : 'daily',
    unit,
    customUnit: unit === 'custom' ? (String(h.customUnit || '').trim().slice(0, 20) || 'units') : undefined,
    target: clampTarget(unit, h.target),
    createdAt: new Date().toISOString(),
    entries: []
  };
  data.habits.push(habit);
  flush();
  return enrichHabit(habit);
}

function updateHabit(id, partial) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  partial = partial || {};
  if (partial.name != null) h.name = String(partial.name).slice(0, 60);
  if (partial.emoji != null) h.emoji = partial.emoji;
  if (partial.color != null) h.color = partial.color;
  if (partial.freqType != null) h.freqType = partial.freqType === 'weekly' ? 'weekly' : 'daily';
  if (partial.unit != null) h.unit = partial.unit === 'minutes' ? 'minutes' : partial.unit === 'custom' ? 'custom' : 'count';
  if (partial.customUnit != null) h.customUnit = String(partial.customUnit).trim().slice(0, 20) || 'units';
  if (partial.target != null) h.target = clampTarget(habitUnit(h), partial.target);
  flush();
  return enrichHabit(h);
}

function deleteHabit(id) {
  data.habits = (data.habits || []).filter((x) => x.id !== id);
  flush();
  return getHabits();
}

// Record a completion. `amount` > 0 adds it; < 0 undoes that much from today.
// `when` (optional) = { date: 'YYYY-MM-DD', time: 'HH:MM' } to backdate the entry for
// statistics; omitted means "now".
function logHabit(id, amount = 1, when = null) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  const entries = habitEntries(h);
  amount = Number(amount) || 0;

  if (amount > 0) {
    let ts;
    if (when && when.date) {
      const time = (when.time && /^\d{2}:\d{2}$/.test(when.time)) ? when.time : '12:00';
      ts = new Date(`${when.date}T${time}:00`).toISOString();
    } else {
      ts = new Date().toISOString();
    }
    entries.push({ ts, amount });
  } else if (amount < 0) {
    // Undo: peel `-amount` off today's most recent entries.
    let remove = -amount;
    const today = dateKey();
    for (let i = entries.length - 1; i >= 0 && remove > 0; i--) {
      if (dateKey(new Date(entries[i].ts)) !== today) continue;
      if (entries[i].amount <= remove) { remove -= entries[i].amount; entries.splice(i, 1); }
      else { entries[i].amount -= remove; remove = 0; }
    }
  }
  flush();
  return enrichHabit(h);
}

// ---- main-streak unification ----
// Daily habits are strict: a past day fails if any daily habit that existed then was
// not fully met. Weekly habits are judged once, on the Saturday that closes their week.
// The current (in-progress) day/week is never marked as failed — only "pending".
// A day obligates a habit if the habit already existed then, OR there is a logged
// entry on that day (so backdated completions count, but creating a habit never
// retroactively fails the days before you started it).
function dailyHabitsState(key) {
  const dailies = (data.habits || []).filter((h) => h.freqType === 'daily');
  if (!dailies.length) return 'na';
  const today = dateKey();
  let any = false, allMet = true;
  for (const h of dailies) {
    const map = dayMapOf(h);
    const created = h.createdAt ? dateKey(new Date(h.createdAt)) : key;
    if (key < created && !(map[key] > 0)) continue; // didn't exist yet and nothing logged
    if (clampTarget(habitUnit(h), h.target) === 0) continue; // track-only habit never blocks streak
    any = true;
    if ((map[key] || 0) < clampTarget(habitUnit(h), h.target)) allMet = false;
  }
  if (!any) return 'na';
  if (allMet) return true;
  return key >= today ? 'pending' : false; // today still in progress => not a miss yet
}

function weeklyHabitsState(key) {
  const d = new Date(key + 'T00:00:00');
  if (d.getDay() !== 6) return 'na';                 // only Saturday represents its week
  const ws = weekStart(d);
  if (dateKey(weekStart()) === dateKey(ws)) return 'na'; // current week not finished
  const weeklies = (data.habits || []).filter((h) => h.freqType === 'weekly');
  const wsKey = dateKey(ws);
  let any = false;
  for (const h of weeklies) {
    const created = h.createdAt ? dateKey(new Date(h.createdAt)) : key;
    const sum = weekSumMap(dayMapOf(h), ws);
    if (wsKey < created && !(sum > 0)) continue; // habit didn't exist that week, nothing logged
    if (clampTarget(habitUnit(h), h.target) === 0) continue; // track-only habit never blocks streak
    any = true;
    if (sum < clampTarget(habitUnit(h), h.target)) return false;
  }
  return any ? true : 'na';
}

// Combine screen-time goals + daily habits + weekly-habit week-ends into one verdict.
// false beats everything (a real miss); a still-pending piece keeps the day neutral.
function checkDayMet(key) {
  const goals = checkGoalsMet(key); // null | true | false
  const states = [goals === null ? 'na' : goals, dailyHabitsState(key), weeklyHabitsState(key)];
  const real = states.filter((s) => s !== 'na');
  if (!real.length) return null;
  if (real.some((s) => s === false)) return false;
  if (real.some((s) => s === 'pending')) return null;
  return true;
}

function habitsConfigured() {
  return (data.habits || []).length > 0;
}

function getSettings() { return data.settings; }
function setSettings(partial) {
  partial = partial || {};
  const next = Object.assign({}, data.settings, partial);
  // breakReminder is nested — merge it so partial updates don't drop other keys
  if (partial.breakReminder) {
    next.breakReminder = Object.assign({}, data.settings.breakReminder, partial.breakReminder);
  }
  data.settings = next;
  flush();
  return data.settings;
}

module.exports = {
  DATA_FILE,
  load,
  flush,
  dateKey,
  addTime,
  getToday,
  rangeData,
  dayTotal,
  getSettings,
  setSettings,
  getGoals,
  setGoal,
  getGlobalLimit,
  setGlobalLimit,
  getStreaks,
  weeklyReport,
  dayOfWeekStats,
  trendAnalysis,
  getReminders,
  setReminder,
  deleteReminder,
  getHabits,
  addHabit,
  updateHabit,
  deleteHabit,
  logHabit,
  raw: () => data
};
