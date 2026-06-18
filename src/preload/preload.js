const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDashboard: (range) => ipcRenderer.invoke('dashboard:get', range),
  getStats: (range) => ipcRenderer.invoke('stats:get', range),
  getState: () => ipcRenderer.invoke('state:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  setTracking: (on) => ipcRenderer.invoke('tracking:set', on),
  toggleTracking: () => ipcRenderer.invoke('tracking:toggle'),
  resetSession: () => ipcRenderer.invoke('session:reset'),

  listBlocked: () => ipcRenderer.invoke('blocked:list'),
  addBlocked: (entry) => ipcRenderer.invoke('blocked:add', entry),
  removeBlocked: (proc) => ipcRenderer.invoke('blocked:remove', proc),
  listRunningApps: () => ipcRenderer.invoke('apps:running'),

  windowControl: (action) => ipcRenderer.invoke('win:control', action),

  onTick: (cb) => ipcRenderer.on('tick', (_e, d) => cb(d)),
  onTrackingChanged: (cb) => ipcRenderer.on('tracking-changed', (_e, d) => cb(d)),
  onBlockedHit: (cb) => ipcRenderer.on('blocked-hit', (_e, d) => cb(d)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, d) => cb(d))
});
