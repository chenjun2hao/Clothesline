'use strict';

/**
 * 每个被监控文件夹一个独立的 watcher 与完成度门控。
 * 移植自 Clothesline (Swift) 的 DownloadsWatcher.swift / FolderMonitors.swift。
 *
 * 监听方式：fs.watch（Linux inotify / Windows ReadDirectoryChangesW）触发即时重扫，
 * 另有 2 秒轮询兜底，处理睡眠唤醒、原子重命名、事件丢失等情况。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { scan, DownloadCompletionGate, byRecency } = require('./downloadIndex');

const RESCAN_DELAY = 250;    // 事件去抖：0.25 秒
const POLL_INTERVAL = 2000;  // 轮询兜底：2 秒

class FolderWatcher extends EventEmitter {
  /** @param {string} folder 绝对路径 */
  constructor(folder) {
    super();
    this.folder = folder;
    this.gate = new DownloadCompletionGate();
    this.watcher = null;
    this.timer = null;
    this.pending = null;
    this.scannerBusy = false;
    this.scanAgain = false;
    this.stopped = true;
  }

  start() {
    this.stop();
    this.stopped = false;
    this.gate = new DownloadCompletionGate();
    try {
      this.watcher = fs.watch(this.folder, { persistent: true }, () => this.schedule());
      this.watcher.on('error', (err) => this.emit('failure', err.message));
    } catch (err) {
      this.emit('failure', err.message);
    }
    this.timer = setInterval(() => this.schedule(true), POLL_INTERVAL);
    this.schedule(true);
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { try { this.watcher.close(); } catch { /* 忽略 */ } this.watcher = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    this.scannerBusy = false;
    this.scanAgain = false;
  }

  schedule(immediate = false) {
    if (this.stopped) return;
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = null; this.run(); },
      immediate ? 0 : RESCAN_DELAY);
    if (this.pending.unref) this.pending.unref();
  }

  async run() {
    if (this.stopped) return;
    if (this.scannerBusy) { this.scanAgain = true; return; }
    this.scannerBusy = true;
    try {
      const files = await scan(this.folder);
      if (this.stopped) return;
      this.emit('failure', null);
      this.emit('update', this.gate.completed(files));
    } catch (err) {
      if (!this.stopped) this.emit('failure', err.message);
    } finally {
      this.scannerBusy = false;
      if (this.scanAgain) { this.scanAgain = false; this.schedule(true); }
    }
  }

  /** 睡眠唤醒/卷重挂后重建监听。 */
  wake() { this.start(); }
}

/**
 * 汇总多个文件夹的快照（合并去重、按最近排序），各自独立门控，互不影响。
 */
class FolderMonitors {
  /**
   * @param {object} opts
   * @param {string} opts.defaultFolder 默认监控目录（系统“下载”目录）
   * @param {(files:Array)=>void} opts.onUpdate 合并后的结果
   */
  constructor({ defaultFolder, onUpdate }) {
    this.defaultFolder = defaultFolder;
    this.onUpdate = onUpdate;
    this.watchers = new Map();   // path -> FolderWatcher
    this.snapshots = new Map();  // path -> files
    this.failures = new Map();   // path -> message
    this.order = [];             // 稳定顺序
  }

  get folders() {
    return this.order.slice();
  }

  start() {
    this.stop();
    this.addWatcher(this.defaultFolder);
  }

  /** 添加一个监控目录（已存在则忽略）。 */
  add(folder) {
    this.addWatcher(folder);
  }

  addWatcher(folder) {
    const key = path.resolve(folder);
    if (this.watchers.has(key)) return;
    let stat;
    try { stat = fs.statSync(key); } catch { return; }
    if (!stat.isDirectory()) return;

    this.order.push(key);
    const watcher = new FolderWatcher(key);
    watcher.on('update', (files) => {
      this.snapshots.set(key, files);
      this.emitMerged();
    });
    watcher.on('failure', (message) => {
      if (message) this.failures.set(key, message);
      else this.failures.delete(key);
    });
    this.watchers.set(key, watcher);
    watcher.start();
  }

  remove(folder) {
    const key = path.resolve(folder);
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.stop();
    this.watchers.delete(key);
    this.snapshots.delete(key);
    this.failures.delete(key);
    this.order = this.order.filter((p) => p !== key);
    this.emitMerged();
  }

  emitMerged() {
    const unique = new Map();
    for (const files of this.snapshots.values()) {
      for (const file of files) unique.set(file.path, file);
    }
    this.onUpdate([...unique.values()].sort(byRecency));
  }

  wake() { for (const w of this.watchers.values()) w.wake(); }

  stop() {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.snapshots.clear();
    this.failures.clear();
    this.order = [];
  }
}

module.exports = { FolderWatcher, FolderMonitors, RESCAN_DELAY, POLL_INTERVAL };