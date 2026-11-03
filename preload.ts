'use strict';
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const builder: BuilderApi = {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  validateProject: (dir) => ipcRenderer.invoke('validate-project', dir),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  checkUpdates: (force = false) => ipcRenderer.invoke('check-updates', force),
  installUpdate: (id, version) => ipcRenderer.invoke('install-update', id, version),
  sdkDefaultDir: () => ipcRenderer.invoke('sdk-default-dir'),
  getDownloadSource: () => ipcRenderer.invoke('get-download-source'),
  setDownloadSource: (id, customBase) => ipcRenderer.invoke('set-download-source', id, customBase),
  installSdkRoot: (dir) => ipcRenderer.invoke('install-sdk-root', dir),
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
  googleConfig: () => ipcRenderer.invoke('google-config'),
  googleConnect: (clientId, clientSecret) => ipcRenderer.invoke('google-connect', clientId, clientSecret),
  googleStatus: () => ipcRenderer.invoke('google-status'),
  googleDisconnect: () => ipcRenderer.invoke('google-disconnect'),
  googleRegister: (req) => ipcRenderer.invoke('google-register', req),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
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
  onGoogleEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, evt: GoogleEvent) => cb(evt);
    ipcRenderer.on('google-event', listener);
    return () => ipcRenderer.removeListener('google-event', listener);
  },
};

contextBridge.exposeInMainWorld('builder', builder);
