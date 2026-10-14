'use strict';

/**
 * 预览窗口：等价于 macOS 的 Quick Look（单击卡片触发）。
 * 使用 Chromium 原生能力渲染图片 / 视频 / 音频 / PDF / 文本，Windows 与 Linux 表现一致。
 */

const api = window.clothesline;
const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const name = params.get('name') || '';
const filePath = params.get('path') || '';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'csv', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'sh', 'bash', 'zsh', 'ini', 'toml', 'conf', 'cfg', 'sql']);

document.getElementById('title').textContent = name;
document.getElementById('open').addEventListener('click', () => api.open(filePath));
document.getElementById('reveal').addEventListener('click', () => api.reveal(filePath));

const content = document.getElementById('content');
const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

build();

async function build() {
  if (IMAGE_EXTS.has(ext)) {
    const img = document.createElement('img');
    img.src = src;
    content.appendChild(img);
    return;
  }
  if (VIDEO_EXTS.has(ext)) {
    const video = document.createElement('video');
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    content.appendChild(video);
    return;
  }
  if (AUDIO_EXTS.has(ext)) {
    const audio = document.createElement('audio');
    audio.src = src;
    audio.controls = true;
    audio.autoplay = true;
    content.appendChild(audio);
    return;
  }
  if (ext === 'pdf') {
    // Chromium 自带 PDF 查看器，Windows / Linux 使用同一渲染引擎。
    const frame = document.createElement('iframe');
    frame.src = src;
    content.appendChild(frame);
    return;
  }
  if (TEXT_EXTS.has(ext)) {
    // 文本由主进程读取（自定义协议跨源 fetch 会被 CORS 拦截）。
    const text = await api.readText(filePath);
    if (typeof text === 'string') {
      const pre = document.createElement('pre');
      pre.textContent = text.length > 400000 ? text.slice(0, 400000) + '\n…（内容过长，已截断）' : text;
      content.appendChild(pre);
      return;
    }
  }
  await showFallback();
}

async function showFallback() {
  const box = document.createElement('div');
  box.className = 'fallback';
  const img = document.createElement('img');
  const data = await api.icon(filePath);
  if (data) img.src = data;
  const p = document.createElement('div');
  p.textContent = '没有内置预览，可用默认应用打开。';
  box.appendChild(img);
  box.appendChild(p);
  content.appendChild(box);
}