'use strict';

/**
 * “接入截图文件”：默认关闭，只读取系统截图保存目录（不改系统设置、不截屏）。
 * 移植自 Clothesline (Swift) 的 ScreenshotMonitor.swift，并补充跨平台命名识别。
 */

const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { FolderWatcher } = require('./folderMonitors');

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'heic', 'tiff', 'bmp', 'webp']);
// 常见截图文件名前缀（macOS / Windows / Linux / 中文系统）。
const SCREENSHOT_PREFIXES = [
  'screenshot', 'screen shot', 'snipaste', '截屏', '屏幕快照', '屏幕截图', '截图', '新建截屏',
];

/** 判断一个下载项是否像“截图”。 */
function isScreenshot(file) {
  if (!file || file.isDirectory) return false;
  const ext = path.extname(file.name).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return false;
  const lower = file.name.toLowerCase();
  return SCREENSHOT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** 取当前平台的默认截图目录。 */
function defaultScreenshotFolder() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const pictures = path.join(home, 'Pictures', 'Screenshots');
    return pictures;
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Desktop');
  }
  // Linux：优先 ~/Pictures/Screenshots，退回 ~/Pictures、~/Desktop。
  return path.join(home, 'Pictures', 'Screenshots');
}

/** 逐级退回：目录不存在时用上一级已存在的目录。 */
function firstExisting(candidates, fallback) {
  const fs = require('fs');
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 继续 */ }
  }
  return fallback;
}

class ScreenshotMonitor extends EventEmitter {
  constructor({ folder = '', enabled = false } = {}) {
    super();
    this.enabled = enabled;
    this.folderPath = folder;
    this.watcher = null;
    this.failure = null;
  }

  /** 当前生效的截图目录。 */
  resolveFolder() {
    const candidates = [];
    if (this.folderPath) candidates.push(this.folderPath);
    const home = os.homedir();
    candidates.push(defaultScreenshotFolder());
    if (process.platform === 'win32') candidates.push(path.join(home, 'Pictures'));
    if (process.platform === 'linux') {
      candidates.push(path.join(home, 'Pictures'));
      candidates.push(path.join(home, 'Desktop'));
    }
    if (process.platform === 'darwin') candidates.push(path.join(home, 'Desktop'));
    return firstExisting(candidates, os.homedir());
  }

  setEnabled(enabled) { this.enabled = enabled; this.restart(); }
  setFolder(folder) { this.folderPath = folder; this.enabled = true; this.restart(); }

  restart() {
    this.stop();
    this.failure = null;
    this.emit('update', []);
    if (!this.enabled) return;
    const folder = this.resolveFolder();
    this.watcher = new FolderWatcher(folder);
    this.watcher.on('update', (files) => this.emit('update', files.filter(isScreenshot)));
    this.watcher.on('failure', (message) => {
      this.failure = message;
      this.emit('failure', message);
    });
    this.watcher.start();
  }

  stop() {
    if (this.watcher) { this.watcher.stop(); this.watcher = null; }
  }
}

module.exports = { ScreenshotMonitor, isScreenshot, defaultScreenshotFolder };