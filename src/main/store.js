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
    streaks: { current: 0, best: 0, lastCheckedDate: null, metDays: {} },
    settings: {
      tracking: true,
      idleThreshold: 120, // seconds with no input => not counted
      pollInterval: 2, // seconds between samples
      autoLaunch: true,
      minimizeToTray: true,
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
      if (parsed.streaks) {
        data.streaks = Object.assign(defaults().streaks, parsed.streaks);
        data.streaks.metDays = parsed.streaks.metDays || {};
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
    data.days[key] = { apps: {}, total: 0, firstSeen: now, lastSeen: now };
  }
  return data.days[key];
}

function addTime(appName, seconds) {
  if (!appName || seconds <= 0) return;
  const day = ensureDay(dateKey());
  day.apps[appName] = (day.apps[appName] || 0) + seconds;
  day.total += seconds;
  day.lastSeen = new Date().toISOString();
  scheduleSave();
}

function getToday() {
  return ensureDay(dateKey());
}

// Aggregate the last `days` days (including today).
function rangeData(days) {
  const result = { apps: {}, total: 0, perDay: [], daysWithData: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const day = data.days[key];
    const total = day ? day.total : 0;
    result.perDay.push({ date: key, total });
    if (day && day.total > 0) {
      result.daysWithData++;
      for (const [a, s] of Object.entries(day.apps)) result.apps[a] = (result.apps[a] || 0) + s;
      result.total += day.total;
    }
  }
  return result;
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
  if (Object.keys(goals).length === 0) return null;
  const day = data.days[key];
  if (!day) return true; // no usage = all limits respected
  for (const [appName, targetSec] of Object.entries(goals)) {
    const actual = (day.apps && day.apps[appName]) || 0;
    if (actual > targetSec) return false; // exceeded limit
  }
  return true;
}

function syncStreaks() {
  if (!data.streaks) data.streaks = defaults().streaks;
  if (!data.streaks.metDays) data.streaks.metDays = {};
  const today = dateKey();
  const goals = data.goals || {};
  if (Object.keys(goals).length > 0) {
    // Re-evaluate the last 30 days so the calendar stays current
    for (let i = 30; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      data.streaks.metDays[dateKey(d)] = checkGoalsMet(dateKey(d));
    }
  }
  let streak = 0;
  const d = new Date();
  while (streak < 366) {
    const k = dateKey(d);
    if (data.streaks.metDays[k] === true) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  data.streaks.current = streak;
  if (streak > (data.streaks.best || 0)) data.streaks.best = streak;
  data.streaks.lastCheckedDate = today;
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
  getStreaks,
  weeklyReport,
  raw: () => data
};
