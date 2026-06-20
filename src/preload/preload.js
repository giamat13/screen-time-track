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

  windowControl: (action) => ipcRenderer.invoke('win:control', action),

  testBreak: () => ipcRenderer.invoke('breaks:testBeep'),
  getBreakStatus: () => ipcRenderer.invoke('breaks:getStatus'),
  respondBreak: (choice) => ipcRenderer.invoke('breaks:respond', choice),

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

  onTick: (cb) => ipcRenderer.on('tick', (_e, d) => cb(d)),
  onTrackingChanged: (cb) => ipcRenderer.on('tracking-changed', (_e, d) => cb(d)),
  onBreakPrompt: (cb) => ipcRenderer.on('break-prompt', (_e, d) => cb(d)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, d) => cb(d))
});
