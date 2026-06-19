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

function getSettings() { return data.settings; }
function setSettings(partial) {
  data.settings = Object.assign({}, data.settings, partial || {});
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
  raw: () => data
};
