'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('builder', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  validateProject: (dir) => ipcRenderer.invoke('validate-project', dir),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  startBuild: (cfg) => ipcRenderer.invoke('start-build', cfg),
  cancelBuild: () => ipcRenderer.invoke('cancel-build'),
  makeZip: (entries) => ipcRenderer.invoke('make-zip', entries),
  saveFile: (srcPath, suggestedName) => ipcRenderer.invoke('save-file', srcPath, suggestedName),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  statPath: (p) => ipcRenderer.invoke('stat-path', p),
  trashPath: (p) => ipcRenderer.invoke('trash-path', p),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  onBuildEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('build-event', listener);
    return () => ipcRenderer.removeListener('build-event', listener);
  },
});
