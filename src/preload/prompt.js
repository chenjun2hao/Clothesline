'use strict';

/** 通用文本输入弹窗（重命名）的预加载脚本。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clothesline', {
  submit: (value) => ipcRenderer.send('prompt:result', value),
  cancel: () => ipcRenderer.send('prompt:result', null),
});