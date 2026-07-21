const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDashboard: (range, offset, filter) => ipcRenderer.invoke('dashboard:get', range, offset, filter),
  getStats: (range, offset, filter) => ipcRenderer.invoke('stats:get', range, offset, filter),
  getState: () => ipcRenderer.invoke('state:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  setTracking: (on) => ipcRenderer.invoke('tracking:set', on),
  toggleTracking: () => ipcRenderer.invoke('tracking:toggle'),
  resetSession: () => ipcRenderer.invoke('session:reset'),
  debugSubtractTime: (seconds) => ipcRenderer.invoke('debug:subtractTime', seconds),

  startNotMe: (name) => ipcRenderer.invoke('notme:start', name),
  endNotMe: () => ipcRenderer.invoke('notme:end'),
  getNotMeLog: () => ipcRenderer.invoke('notme:log'),

  windowControl: (action) => ipcRenderer.invoke('win:control', action),

  testBreak: () => ipcRenderer.invoke('breaks:testBeep'),
  getBreakStatus: () => ipcRenderer.invoke('breaks:getStatus'),
  respondBreak: (choice, reason) => ipcRenderer.invoke('breaks:respond', choice, reason),
  forceBreak: () => ipcRenderer.invoke('breaks:force'),
  telegramTest: () => ipcRenderer.invoke('breaks:telegramTest'),

  getGoals: () => ipcRenderer.invoke('goals:get'),
  setGoal: (appName, targetSec) => ipcRenderer.invoke('goals:set', appName, targetSec),
  getGlobalLimit: () => ipcRenderer.invoke('limit:getGlobal'),
  setGlobalLimit: (seconds) => ipcRenderer.invoke('limit:setGlobal', seconds),
  getStreaks: () => ipcRenderer.invoke('streaks:get'),
  getWeeklyReport: () => ipcRenderer.invoke('weekly:get'),

  getReminders: () => ipcRenderer.invoke('reminders:get'),
  setReminder: (r) => ipcRenderer.invoke('reminders:set', r),
  deleteReminder: (id) => ipcRenderer.invoke('reminders:delete', id),

  getHabits: () => ipcRenderer.invoke('habits:get'),
  addHabit: (h) => ipcRenderer.invoke('habits:add', h),
  updateHabit: (id, partial) => ipcRenderer.invoke('habits:update', id, partial),
  deleteHabit: (id) => ipcRenderer.invoke('habits:delete', id),
  logHabit: (id, amount, when) => ipcRenderer.invoke('habits:log', id, amount, when),
  pauseHabit: (id) => ipcRenderer.invoke('habits:pause', id),
  debugAddHabitFreezers: (id, count) => ipcRenderer.invoke('debug:addHabitFreezers', id, count),

  forestGetState: () => ipcRenderer.invoke('forest:getState'),
  forestStart: (opts) => ipcRenderer.invoke('forest:start', opts),
  forestPause: () => ipcRenderer.invoke('forest:pause'),
  forestResume: () => ipcRenderer.invoke('forest:resume'),
  forestGiveup: () => ipcRenderer.invoke('forest:giveup'),
  forestFinish: () => ipcRenderer.invoke('forest:finish'),
  forestBuySpecies: (id) => ipcRenderer.invoke('forest:buySpecies', id),
  forestSelectSpecies: (id) => ipcRenderer.invoke('forest:selectSpecies', id),
  forestSetDistractions: (d) => ipcRenderer.invoke('forest:setDistractions', d),
  forestSetTags: (tags) => ipcRenderer.invoke('forest:setTags', tags),
  forestSetSettings: (partial) => ipcRenderer.invoke('forest:setSettings', partial),
  forestAddTask: (title) => ipcRenderer.invoke('forest:tasks:add', title),
  forestToggleTask: (id) => ipcRenderer.invoke('forest:tasks:toggle', id),
  forestDeleteTask: (id) => ipcRenderer.invoke('forest:tasks:delete', id),
  onForestTick: (cb) => ipcRenderer.on('forest-tick', (_e, d) => cb(d)),
  onForestEnded: (cb) => ipcRenderer.on('forest-ended', (_e, d) => cb(d)),

  onTick: (cb) => ipcRenderer.on('tick', (_e, d) => cb(d)),
  onTrackingChanged: (cb) => ipcRenderer.on('tracking-changed', (_e, d) => cb(d)),
  onBreakPrompt: (cb) => ipcRenderer.on('break-prompt', (_e, d) => cb(d)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, d) => cb(d))
});

// Bridge used by the fullscreen lock window (lock.html / lock.js).
contextBridge.exposeInMainWorld('lock', {
  getState: () => ipcRenderer.invoke('lock:getState'),
  approve: (reason) => ipcRenderer.invoke('lock:approve', reason),
  release: () => ipcRenderer.invoke('lock:release'),
  onTick: (cb) => ipcRenderer.on('lock:tick', (_e, d) => cb(d)),
});
