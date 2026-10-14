'use strict';

/**
 * 平台无关的“下载文件过滤 + 完成度门控”。
 * 直接移植自 Clothesline (Swift) 的 DownloadIndex.swift。
 *
 * 一个文件名本身并不能证明浏览器已经写完它，所以：
 *  - 过滤隐藏文件、临时下载后缀；
 *  - 要求连续两次 stat 完全一致，且距最后一次写入超过静默期，才认为“下载完成”。
 */

const fsp = require('fs').promises;
const path = require('path');

/** 浏览器/下载器的临时后缀：出现在这些后缀时，不能认为下载完成。 */
const TEMPORARY_SUFFIXES = new Set([
  'crdownload', 'download', 'part', 'partial', 'tmp', 'temp',
  'opdownload', 'aria2', 'filepart', 'dms', 'downloadfile',
]);

/** 文件名是否是“候选下载项”。 */
function isCandidateName(name) {
  if (!name) return false;
  if (name.startsWith('.')) return false;       // 隐藏文件
  if (name.startsWith('~$')) return false;      // Office 临时文件
  const ext = path.extname(name).slice(1).toLowerCase();
  if (TEMPORARY_SUFFIXES.has(ext)) return false;
  if (name.endsWith('.DS_Store')) return false;
  return true;
}

/**
 * 读取一个路径的下载项元数据；不是普通文件/目录、是符号链接或隐藏文件时返回 null。
 * @returns {Promise<null|{path:string,url:string,name:string,size:number,modified:number,created:number,added:number|null,isDirectory:boolean,fingerprint:string}>}
 */
async function read(targetPath) {
  let st;
  try {
    st = await fsp.lstat(targetPath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null;
  const isDirectory = st.isDirectory();
  if (!isDirectory && !st.isFile()) return null;

  const name = path.basename(targetPath);
  if (name.startsWith('.')) return null; // 隐藏文件

  const size = isDirectory ? 0 : st.size;
  const modified = st.mtimeMs;
  const created = st.birthtimeMs || modified;
  return makeFile(targetPath, size, modified, created, isDirectory);
}

/** 组装 DownloadFile（保证 path 为规范化绝对路径）。 */
function makeFile(targetPath, size, modified, created, isDirectory) {
  const abs = path.resolve(targetPath);
  const file = {
    path: abs,
    url: pathToFileURL(abs),
    name: path.basename(abs),
    size,
    modified,
    created,
    added: null, // 其他平台没有 macOS 的“加入目录时间”，退回 created
    isDirectory,
  };
  file.fingerprint = fingerprintOf(file);
  return file;
}

/** 目录用路径+创建时间；文件用路径+大小+修改时间+创建时间。 */
function fingerprintOf(file) {
  if (file.isDirectory) {
    return `${file.path}|directory|${file.created / 1000}`;
  }
  return `${file.path}|${file.size}|${file.modified / 1000}|${file.created / 1000}`;
}

/** 重新计算 fingerprint（映射字段后使用）。 */
function fingerprint(file) {
  return fingerprintOf(file);
}

function pathToFileURL(p) {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') resolved = resolved.replace(/\\/g, '/');
  if (!resolved.startsWith('/')) resolved = '/' + resolved;
  return encodeURI('file://' + resolved).replace(/[?#]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 排序：最近的在前；并列时路径降序。 */
function byRecency(a, b) {
  const ra = a.added ?? a.created;
  const rb = b.added ?? b.created;
  if (ra !== rb) return rb - ra;
  return a.path > b.path ? -1 : a.path < b.path ? 1 : 0;
}

/** 列出目录（不递归、跳过隐藏项），过滤临时/隐藏文件并排序。 */
async function scan(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (err) {
    throw err;
  }

  // 浏览器可能一边流式写入最终文件名、一边保留临时兄弟文件（foo.pdf.crdownload）。
  // 在临时文件消失前，先不显示对应的最终文件。
  const inProgress = new Set();
  for (const ent of entries) {
    const ext = path.extname(ent.name).slice(1).toLowerCase();
    if (TEMPORARY_SUFFIXES.has(ext)) {
      inProgress.add(ent.name.slice(0, ent.name.length - (ext.length + 1)));
    }
  }

  const result = [];
  for (const ent of entries) {
    if (!isCandidateName(ent.name)) continue;
    if (inProgress.has(ent.name)) continue;
    const file = await read(path.join(directory, ent.name));
    if (file) result.push(file);
  }
  return result.sort(byRecency);
}

/**
 * 完成度门控：要求两次完全一致的 stat 样本，且距离最后一次写入超过静默期。
 * 启动时对已完成的下载大约增加 1 秒；对正在写入的大文件可避免提前显示。
 */
class DownloadCompletionGate {
  constructor({ requiredSamples = 2, quietPeriod = 2 } = {}) {
    this.requiredSamples = Math.max(2, requiredSamples);
    this.quietPeriod = quietPeriod;
    this.previous = new Map();
    this.counts = new Map();
  }

  reset() {
    this.previous.clear();
    this.counts.clear();
  }

  /**
   * @param {Array} files 扫描结果
   * @param {number} now 当前时间（毫秒）
   * @returns {Array} 已经稳定、可以显示的文件
   */
  completed(files, now = Date.now()) {
    const next = new Map();
    const nextCounts = new Map();
    const finished = [];
    for (const file of files) {
      const key = file.path;
      const sig = `${file.size}|${file.modified}|${file.created}`;
      next.set(key, sig);
      const count = this.previous.get(key) === sig ? (this.counts.get(key) || 0) + 1 : 1;
      nextCounts.set(key, count);
      // 有的浏览器先创建目标文件再往里写，所以“稳定样本”和“静默写入窗口”都需要。
      const recentlyTouched = Math.max(file.modified, file.added ?? file.created);
      if (count >= this.requiredSamples && (now - recentlyTouched) / 1000 >= this.quietPeriod) {
        finished.push(file);
      }
    }
    this.previous = next;
    this.counts = nextCounts;
    return finished;
  }
}

module.exports = {
  TEMPORARY_SUFFIXES,
  isCandidateName,
  read,
  makeFile,
  fingerprint,
  fingerprintOf,
  byRecency,
  scan,
  DownloadCompletionGate,
  pathToFileURL,
};