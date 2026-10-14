'use strict';

/**
 * 晾衣绳的“文件列表模型”，移植自 Clothesline (Swift) 的 Line.swift。
 *
 * 关键安全约定（与 macOS 版一致）：
 *  - “取下 / 清空 / 退出”只改变显示状态，绝不删除、移动或覆盖源文件；
 *  - 只有用户明确选择“移到废纸篓”并确认后，才把源文件移入系统回收站/废纸篓；
 *  - 重命名、删除前都会重新读取元数据并与卡片指纹核对，不一致则拒绝操作。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { makeFile, byRecency } = require('./downloadIndex');

const RECORDING_EXTS = new Set(['mov', 'mp4', 'm4v', 'avi', 'webm', 'mkv']);
const MAX_RECENT = 200;

class Line extends EventEmitter {
  /** @param {import('./settings').Settings} settings */
  constructor(settings) {
    super();
    this.settings = settings;
    this.latest = [];                 // 监控得到的文件（最新在前）
    this.attached = [];               // 手动挂上的文件/文件夹路径（入口）
    this.recent = [];                 // 最近文件入口，最多 200
    this.dismissed = new Set(settings.get('dismissedFiles') || []);
    this.maxItems = 8;
    this.visibleCount = 8;
    this.restoreRecent();
  }

  // ---- 最近文件 ----

  restoreRecent() {
    const paths = this.settings.get('recentFiles') || [];
    const valid = [];
    for (const p of paths) {
      const file = safeRead(p);
      if (file) valid.push(file);
    }
    this.recent = dedupeByPath(valid).sort(byRecency).slice(0, MAX_RECENT);
  }

  /** 把一批文件并入“最近文件”，保持有效性与顺序。 */
  remember(files) {
    const map = new Map(this.recent.map((f) => [f.path, f]));
    for (const file of files) map.set(file.path, file);
    const updated = dedupeByPath([...map.values()].map((f) => safeRead(f.path)))
      .sort(byRecency).slice(0, MAX_RECENT);
    if (samePaths(updated, this.recent)) return;
    this.recent = updated;
    this.settings.set('recentFiles', updated.map((f) => f.path));
  }

  recentFiles(query = '') {
    const q = query.trim().toLowerCase();
    return this.recent
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((f) => safeRead(f.path))
      .filter(Boolean);
  }

  // ---- 可见列表 ----

  adopt(files) {
    this.latest = files;
    this.remember(files);
    // 扫描为空（启动瞬间/文件正在变化）不代表被取下的文件被删除了。
    this.updateVisibleItems();
  }

  /** 计算并返回当前应该显示的条目（不含缩略图，渲染层负责）。 */
  updateVisibleItems() {
    const attachedFiles = this.attached.map((p) => safeRead(p)).filter(Boolean);
    const attachedPaths = new Set(attachedFiles.map((f) => f.path));
    const combined = attachedFiles.concat(this.latest.filter((f) => !attachedPaths.has(f.path)));
    this.remember(combined);

    const visible = combined
      .filter((f) => !this.dismissed.has(f.fingerprint))
      .slice(0, this.maxItems)
      .reverse(); // 最旧的在左，最新的在右（与 macOS 一致）

    const items = visible.map((file) => ({
      fingerprint: file.fingerprint,
      path: file.path,
      name: file.name,
      url: file.url,
      size: file.size,
      modified: file.modified,
      isDirectory: file.isDirectory,
      isRecording: !file.isDirectory && RECORDING_EXTS.has(extOf(file.name)),
    }));
    this.items = items;
    return items;
  }

  // ---- 取下（只影响显示） ----

  dismiss(fp) {
    this.dismissed.add(fp);
    this.settings.set('dismissedFiles', [...this.dismissed]);
    return this.updateVisibleItems();
  }

  dismissAll() {
    for (const item of this.items || []) this.dismissed.add(item.fingerprint);
    this.settings.set('dismissedFiles', [...this.dismissed]);
    return this.updateVisibleItems();
  }

  resetDismissed() {
    this.dismissed.clear();
    this.settings.set('dismissedFiles', []);
    return this.updateVisibleItems();
  }

  // ---- 挂上入口（不移动原文件） ----

  attachPaths(paths) {
    let changed = false;
    for (const p of paths) {
      const file = safeRead(p);
      if (!file) continue;
      const abs = file.path;
      if (!this.attached.includes(abs)) {
        this.attached.unshift(abs);
        changed = true;
      }
      // 重新挂上时清除它的隐藏记录。
      if (this.dismissed.delete(file.fingerprint)) changed = true;
    }
    if (changed) {
      this.settings.set('attachedFolders', this.attached);
      this.settings.set('dismissedFiles', [...this.dismissed]);
      this.updateVisibleItems();
    }
    // 把挂上的内容也记入“最近文件”。
    this.remember(this.attached.map((p) => safeRead(p)).filter(Boolean));
    return changed;
  }

  restoreAttached() {
    this.attached = (this.settings.get('attachedFolders') || []).filter((p) => {
      try { fs.statSync(p); return true; } catch { return false; }
    });
  }

  // ---- 真实文件操作（重命名 / 移到废纸篓） ----

  /**
   * 重命名：保留扩展名；同名不覆盖；卡片已变化则拒绝。
   * @returns {{ok:boolean, error?:string, path?:string}}
   */
  rename(targetPath, expectedFp, stemRaw) {
    const item = (this.items || []).find((i) => i.path === targetPath);
    const fresh = safeRead(targetPath);
    if (!item || !fresh || fresh.fingerprint !== expectedFp || fresh.fingerprint !== item.fingerprint) {
      return { ok: false, error: '文件已改变或不存在，请刷新后重试。' };
    }
    const stem = String(stemRaw || '').trim();
    if (!stem || stem.startsWith('.') ||
        /[\\/:*?"<>|\0]/.test(stem)) {
      return { ok: false, error: '名称不能为空或包含 / \\ : * ? " < > | 等无效字符。' };
    }
    const isDir = item.isDirectory;
    const ext = isDir ? '' : extOf(item.name);
    const dir = path.dirname(targetPath);
    const newName = ext ? `${stem}.${ext}` : stem;
    const target = path.join(dir, newName);
    if (target === targetPath) return { ok: true, path: targetPath };
    if (fs.existsSync(target)) {
      return { ok: false, error: '同名文件已存在，请使用其他名称。不会覆盖原文件。' };
    }
    try {
      fs.renameSync(targetPath, target);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // 更新内部引用。
    this.attached = this.attached.map((p) => (p === targetPath ? target : p));
    this.settings.set('attachedFolders', this.attached);
    this.latest = this.latest.filter((f) => f.path !== targetPath);
    this.recent = this.recent.filter((f) => f.path !== targetPath);
    const updated = safeRead(target);
    if (updated) {
      this.latest.unshift(updated);
      this.remember([updated]);
    }
    return { ok: true, path: target, items: this.updateVisibleItems() };
  }

  /**
   * 移到废纸篓：先核对卡片元数据，再用 Electron 的 shell.trashItem 移入
   * 系统回收站/废纸篓（可恢复，绝不永久删除）。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async moveToTrash(targetPath, expectedFp, trashItem) {
    const item = (this.items || []).find((i) => i.path === targetPath);
    const fresh = safeRead(targetPath);
    if (!item || !fresh || fresh.fingerprint !== expectedFp || fresh.fingerprint !== item.fingerprint) {
      return { ok: false, error: '文件已改变或不存在，请等待刷新后重试。' };
    }
    try {
      await trashItem(targetPath);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.latest = this.latest.filter((f) => f.path !== targetPath);
    this.recent = this.recent.filter((f) => f.path !== targetPath);
    this.attached = this.attached.filter((p) => p !== targetPath);
    this.settings.set('attachedFolders', this.attached);
    this.remember([]);
    return { ok: true, items: this.updateVisibleItems() };
  }
}

// ---- 小工具 ----

function safeRead(p) {
  try {
    // 同步读取（Line 的操作都是低频的，保持模型简单）。
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return null;
    const isDirectory = st.isDirectory();
    if (!isDirectory && !st.isFile()) return null;
    const name = path.basename(p);
    if (name.startsWith('.')) return null;
    return makeFile(p, isDirectory ? 0 : st.size, st.mtimeMs, st.birthtimeMs || st.mtimeMs, isDirectory);
  } catch {
    return null;
  }
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function dedupeByPath(files) {
  const map = new Map();
  for (const f of files) if (f) map.set(f.path, f);
  return [...map.values()];
}

function samePaths(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].path !== b[i].path) return false;
  return true;
}

module.exports = { Line, RECORDING_EXTS, extOf };