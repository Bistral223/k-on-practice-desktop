const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  cmd: (name, arg) => ipcRenderer.send('kon:panel', name, arg),
  onState: cb => ipcRenderer.on('kon:tab-state', (_e, st) => cb(st)),
  onDrag: cb => ipcRenderer.on('kon:drag', (_e, on) => cb(on)),
  onSaved: cb => ipcRenderer.on('kon:saved', (_e, saved) => cb(saved)),
});
