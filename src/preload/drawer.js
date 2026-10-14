'use strict';

/** “最近文件”抽屉窗口的预加载脚本。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clothesline', {
  list: (query) => ipcRenderer.invoke('drawer:list', { query }),
  action: (name, payload = {}) => ipcRenderer.invoke('drawer:action', { name, payload }),
  icon: (filePath) => ipcRenderer.invoke('line:icon', { path: filePath }),
  dragStart: (filePath) => ipcRenderer.send('line:dragStart', { path: filePath }),
  platform: process.platform,
});