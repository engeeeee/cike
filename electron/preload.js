'use strict';
/**
 * Preload: minimal bridge. The renderer talks to the Local API over HTTP;
 * only connection info and a few native actions cross the bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const connection = ipcRenderer.sendSync('connection-info');
contextBridge.exposeInMainWorld('lfb', {
  apiBase: connection.apiBase || '',
  token: connection.token || '',
  readProxyClipboard: () => ipcRenderer.invoke('proxy-clipboard'),
  chromiumStatus: () => ipcRenderer.invoke('chromium-status'),
  chromiumDownload: () => ipcRenderer.invoke('chromium-download'),
  onChromiumProgress: (cb) => ipcRenderer.on('chromium-download-progress', (_e, p) => cb(p)),
  nativeStatus: () => ipcRenderer.invoke('native-status'),
  nativeDiagnosticsExport: () => ipcRenderer.invoke('native-diagnostics-export'),
  nativeDownload: () => ipcRenderer.invoke('native-download'),
  onNativeProgress: (cb) => ipcRenderer.on('native-download-progress', (_e, p) => cb(p)),
  nativeStorageStatus: () => ipcRenderer.invoke('native-storage-status'),
  nativeStorageChange: () => ipcRenderer.invoke('native-storage-change'),
  nativeStorageRemove: id => ipcRenderer.invoke('native-storage-remove', id),
  nativeStorageOpen: id => ipcRenderer.invoke('native-storage-open', id),
  onNativeStorageProgress: cb => ipcRenderer.on('native-storage-progress', (_e, p) => cb(p)),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
});
