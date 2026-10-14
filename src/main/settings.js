'use strict';

/**
 * 本地持久化设置（替代 macOS 版的 UserDefaults）。
 * 全部功能都在本机运行：只写一个 JSON 文件，不联网、不遥测。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  /** 被“取下/清空”隐藏的文件指纹；重新下载（新指纹）后会再次出现。 */
  dismissedFiles: [],
  /** 屏幕上保留的文件数量：0 表示“屏幕可容纳数量”。 */
  keepOnLine: 0,
  /** 卡片尺寸：small | medium | large */
  lineSize: 'medium',
  /** 是否一直显示晾衣绳。 */
  alwaysShowLine: false,
  /** 持续监控的文件夹绝对路径（默认始终包含“下载”目录）。 */
  monitoredFolders: [],
  /** 手动挂上的文件/文件夹绝对路径（入口，不移动原文件）。 */
  attachedFolders: [],
  /** 最近文件入口，最多 200 个。 */
  recentFiles: [],
  /** 是否接入截图文件。 */
  screenshotMonitoring: false,
  /** 截图保存目录（为空则用系统默认）。 */
  screenshotFolder: '',
};

class Settings {
  /** @param {string} filePath settings.json 的完整路径 */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      // 首次运行或文件损坏：使用默认值。
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[settings] 保存失败:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  /** 检查值在给定集合里，否则返回 fallback。 */
  getChoice(key, choices, fallback) {
    const v = this.data[key];
    return choices.includes(v) ? v : fallback;
  }
}

module.exports = { Settings, DEFAULTS };