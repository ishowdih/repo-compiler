'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),

  startCompile: (url) => ipcRenderer.invoke('compile:start', url),
  cancelCompile: () => ipcRenderer.invoke('compile:cancel'),

  openPath: (p) => ipcRenderer.invoke('path:open', p),
  runApp: (id) => ipcRenderer.invoke('app:run', id),
  deleteEntry: (id, removeFiles) => ipcRenderer.invoke('history:delete', id, removeFiles),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  onLog: (cb) => on('compile:log', cb),
  onStage: (cb) => on('compile:stage', cb),
  onDone: (cb) => on('compile:done', cb),
});
