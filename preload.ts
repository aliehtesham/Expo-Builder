'use strict';
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const builder: BuilderApi = {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  validateProject: (dir) => ipcRenderer.invoke('validate-project', dir),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  checkUpdates: (force = false) => ipcRenderer.invoke('check-updates', force),
  installUpdate: (id, version) => ipcRenderer.invoke('install-update', id, version),
  cancelInstall: () => ipcRenderer.invoke('cancel-install'),
  startBuild: (cfg) => ipcRenderer.invoke('start-build', cfg),
  cancelBuild: () => ipcRenderer.invoke('cancel-build'),
  makeZip: (entries) => ipcRenderer.invoke('make-zip', entries),
  saveFile: (srcPath, suggestedName) => ipcRenderer.invoke('save-file', srcPath, suggestedName),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  statPath: (p) => ipcRenderer.invoke('stat-path', p),
  trashPath: (p) => ipcRenderer.invoke('trash-path', p),
  renameKeystore: (projectDir) => ipcRenderer.invoke('rename-keystore', projectDir),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  saveSecrets: (projectDir, secrets) => ipcRenderer.invoke('vault-save', projectDir, secrets),
  loadSecrets: (projectDir) => ipcRenderer.invoke('vault-load', projectDir),
  secretStatus: (projectDir) => ipcRenderer.invoke('vault-status', projectDir),
  forgetSecrets: (projectDir) => ipcRenderer.invoke('vault-forget', projectDir),
  cancelVaultAuth: () => ipcRenderer.invoke('vault-cancel-hello'),
  onVaultAuthEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, phase: 'prompt') => cb(phase);
    ipcRenderer.on('vault-auth', listener);
    return () => ipcRenderer.removeListener('vault-auth', listener);
  },
  onBuildEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, evt: BuildEvent) => cb(evt);
    ipcRenderer.on('build-event', listener);
    return () => ipcRenderer.removeListener('build-event', listener);
  },
  onUpdateEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, evt: UpdateEvent) => cb(evt);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  },
};

contextBridge.exposeInMainWorld('builder', builder);
