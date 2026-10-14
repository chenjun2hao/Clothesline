'use strict';

/**
 * 顶部浮层的预加载脚本：向渲染层暴露最小 IPC 接口，
 * 并在这里处理来自文件管理器的原生拖入（只保存入口，不移动原文件）。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clothesline', {
  init: () => ipcRenderer.invoke('line:init'),
  action: (name, payload = {}) => ipcRenderer.invoke('line:action', { name, payload }),
  rects: (payload) => ipcRenderer.send('line:rects', payload),
  dragState: (active) => ipcRenderer.send('line:dragState', active),
  dragStart: (filePath) => ipcRenderer.send('line:dragStart', { path: filePath }),
  contextMenu: (payload) => ipcRenderer.send('line:contextMenu', payload),
  icon: (filePath) => ipcRenderer.invoke('line:icon', { path: filePath }),
  pdfThumb: (filePath) => ipcRenderer.invoke('line:pdfThumb', { path: filePath }),
  onConfig: (cb) => ipcRenderer.on('line:config', (_e, data) => cb(data)),
  onState: (cb) => ipcRenderer.on('line:state', (_e, data) => cb(data)),
  platform: process.platform,
});

// ---- 原生拖入：把真实文件路径回传给主进程挂上晾衣绳 ----
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  ipcRenderer.send('line:dragState', true);
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  ipcRenderer.send('line:dragState', true);
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) ipcRenderer.send('line:dragState', false);
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  ipcRenderer.send('line:dragState', false);
  const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
  const paths = files
    .map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } })
    .filter(Boolean);
  if (paths.length) ipcRenderer.invoke('line:action', { name: 'attachFiles', payload: { paths } });
});