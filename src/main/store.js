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

function setGoal(appName, targetSeconds) {
  if (!data.goals) data.goals = {};
  if (!targetSeconds || targetSeconds <= 0) {
    delete data.goals[appName];
  } else {
    data.goals[appName] = Math.round(targetSeconds);
  }
  flush();
  return data.goals;
}

function checkGoalsMet(key) {
  const goals = data.goals || {};
  const globalLimit = data.globalLimit || 0;
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
  const active = Object.keys(goals).length > 0 || (data.globalLimit || 0) > 0;
  if (active) {
    // Re-evaluate the last 30 days so the calendar stays current
    for (let i = 30; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      data.streaks.metDays[dateKey(d)] = checkGoalsMet(dateKey(d));
    }
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
        streak = Math.max(0, streak - 1); // freezer saves the streak, costs a day
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
  if (best > (data.streaks.best || 0)) data.streaks.best = best;
  data.streaks.lastCheckedDate = today;
}

function getGlobalLimit() { return data.globalLimit || 0; }

function setGlobalLimit(seconds) {
  data.globalLimit = (!seconds || seconds <= 0) ? 0 : Math.round(seconds);
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
  raw: () => data
};
