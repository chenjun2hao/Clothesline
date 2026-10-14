'use strict';

/** 预览窗口（单击卡片，等价于 macOS 的 Quick Look）的预加载脚本。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clothesline', {
  icon: (filePath) => ipcRenderer.invoke('preview:icon', { path: filePath }),
  open: (filePath) => ipcRenderer.invoke('preview:open', { path: filePath }),
  reveal: (filePath) => ipcRenderer.invoke('preview:reveal', { path: filePath }),
  readText: (filePath) => ipcRenderer.invoke('preview:readText', { path: filePath }),
});