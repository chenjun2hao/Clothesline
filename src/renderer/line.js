'use strict';

/**
 * 顶部晾衣绳的渲染层逻辑。
 * 位置、尺寸、动画参数与 macOS (SwiftUI) 版 Layout / PeggedView 一一对应。
 */

const api = window.clothesline;

const PIN_PALETTE = [
  '235,92,102',   // 红
  '250,171,56',   // 橙
  '82,184,125',   // 绿
  '71,163,232',   // 蓝
  '158,117,217',  // 紫
  '235,120,173',  // 粉
];

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'ogv']);
const RECORDING_EXTS = new Set(['mov', 'mp4', 'm4v', 'avi', 'webm', 'mkv']);

let cfg = null;          // { layout, size, keepOnLine }
let state = null;        // { items, revealed, visibleCount, scroll, pinned }
const cards = new Map(); // fingerprint -> card 记录
let measureCtx = null;
let rectsScheduled = false;

// ============================ 弹簧（与 SwiftUI 的 spring 参数一致） ============================

class Spring {
  constructor(stiffness, damping, value = 0, target = 0) {
    this.k = stiffness;
    this.c = damping;
    this.x = value;
    this.target = target;
    this.v = 0;
  }

  /** 半隐式欧拉，固定 1/240 秒子步，保证跨平台一致。 */
  step(dt) {
    let remaining = dt;
    const h = 1 / 240;
    while (remaining > 1e-6) {
      const s = Math.min(h, remaining);
      remaining -= s;
      const a = -this.k * (this.x - this.target) - this.c * this.v;
      this.v += a * s;
      this.x += this.v * s;
    }
    if (Math.abs(this.x - this.target) < 0.02 && Math.abs(this.v) < 0.02) {
      this.x = this.target;
      this.v = 0;
      return true;
    }
    return false;
  }
}

/** 由 spring(response:dampingFraction:) 换算的刚度与阻尼。 */
function responseSpring(response, dampingFraction) {
  const k = Math.pow((2 * Math.PI) / response, 2);
  const c = dampingFraction * 2 * Math.sqrt(k);
  return { k, c };
}

const ARRIVE_K = 223.8;   // response 0.42
const ARRIVE_C = 21.5;    // dampingFraction 0.72（用于夹子首次摆动）

let springLoopRunning = false;
let lastFrame = 0;

function ensureSpringLoop() {
  if (springLoopRunning) return;
  springLoopRunning = true;
  lastFrame = performance.now();
  requestAnimationFrame(tick);
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  let busy = false;
  for (const card of cards.values()) {
    busy = stepCardAnimation(card, dt) || busy;
  }
  if (busy) requestAnimationFrame(tick);
  else springLoopRunning = false;
}

function stepCardAnimation(card, dt) {
  let busy = false;

  // 夹子摆动
  if (card.swingSpring) {
    const settled = card.swingSpring.step(dt);
    card.swing = card.swingSpring.x;
    if (settled) card.swingSpring = null;
    else busy = true;
  }

  // 阵风：先缓动到 2.5°，再弹回 0°
  if (card.gust) {
    const g = card.gust;
    if (g.phase === 'ease') {
      g.t += dt;
      const p = Math.min(1, g.t / 0.4);
      card.swing = 2.5 * (1 - Math.pow(1 - p, 3));
      if (p >= 1) { g.phase = 'wait'; g.t = 0; }
      busy = true;
    } else if (g.phase === 'wait') {
      g.t += dt;
      if (g.t >= 0.35) { g.phase = 'spring'; card.swingSpring = new Spring(38, 2.4, card.swing, 0); }
      busy = true;
    } else {
      card.gust = null;
    }
  }

  applyRotation(card);
  return busy;
}

function applyRotation(card) {
  const angle = card.swing + card.tilt;
  card.el.style.transform = `rotate(${angle.toFixed(3)}deg)`;
}

function startSwing(card, from, k, c) {
  card.swing = from;
  card.swingSpring = new Spring(k, c, from, 0);
  ensureSpringLoop();
}

// ============================ 初始化 ============================

async function boot() {
  const data = await api.init();
  applyConfig(data);
  api.onConfig((next) => applyConfig(next));
  api.onState((next) => applyState(next));
  applyState(data.state);

  window.addEventListener('resize', () => { if (cfg) { drawRope(cfg.layout); renderAll(); } });
  window.addEventListener('wheel', onWheel, { passive: true });
  document.getElementById('recentBtn').addEventListener('click', () => api.action('showRecent'));

  // 定期的轻微“阵风”（与 macOS 的 16 秒节奏一致）。
  setInterval(() => { for (const card of cards.values()) card.gust = { phase: 'ease', t: 0 }; ensureSpringLoop(); }, 16000);
}

function applyConfig(data) {
  cfg = data;
  const L = data.layout;
  const s = document.documentElement.style;
  s.setProperty('--card-w', `${L.cardWidth}px`);
  s.setProperty('--photo-h', `${L.photoMaxHeight}px`);
  s.setProperty('--panel-h', `${L.panelHeight}px`);
  s.setProperty('--rope-top', `${L.ropeTop}px`);
  s.setProperty('--pin-above', `${L.pinAbove}px`);
  s.setProperty('--width', `${L.width}px`);
  drawRope(L);
  renderAll();
}

function applyState(next) {
  state = next;
  renderAll();
}

// ============================ 绳子 ============================

function drawRope(L) {
  const svg = document.getElementById('rope');
  const w = L.width;
  const sag = Math.min(30, w * 0.018);
  const top = L.ropeTop;
  const d = `M -20 ${top} Q ${w / 2} ${top + 2 * sag} ${w + 20} ${top}`;
  svg.setAttribute('viewBox', `0 0 ${w} ${L.panelHeight}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(L.panelHeight));
  svg.innerHTML = `
    <defs>
      <linearGradient id="ropeFade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/>
        <stop offset="0.08" stop-color="#fff" stop-opacity="1"/>
        <stop offset="0.92" stop-color="#fff" stop-opacity="1"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <mask id="ropeMask">
        <rect x="0" y="0" width="${w}" height="${L.panelHeight}" fill="url(#ropeFade)"/>
      </mask>
      <filter id="ropeShadow" x="-20%" y="-200%" width="140%" height="500%">
        <feGaussianBlur stdDeviation="1.2"/>
      </filter>
    </defs>
    <g mask="url(#ropeMask)">
      <path d="${d}" fill="none" stroke="rgba(0,0,0,0.22)" stroke-width="1.4"
            transform="translate(0,1.2)" filter="url(#ropeShadow)"/>
      <path d="${d}" fill="none" stroke="rgb(140,140,140)" stroke-width="1.2"/>
      <path d="${d}" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="0.4"
            transform="translate(0,-0.35)"/>
    </g>`;
}

// ============================ 布局计算（对应 Swift 的 Layout.x / ropeY） ============================

function ropeY(x, L) {
  if (!L.width) return L.ropeTop;
  const f = x / L.width;
  const sag = Math.min(30, L.width * 0.018);
  return L.ropeTop + 4 * sag * f * (1 - f);
}

function xFor(index, count, L, visible, scroll) {
  const spacing = L.spacing;
  const keep = cfg.keepOnLine;
  if (keep && count > visible) {
    const newest = L.width / 2 + ((visible - 1) * spacing) / 2;
    return newest - (count - 1 - index) * spacing + scroll;
  }
  const gaps = Math.max(count - 1, 0);
  const step = gaps > 0 ? Math.min(spacing, Math.max(0, L.width - 200) / gaps) : spacing;
  return L.width / 2 - (gaps * step) / 2 + index * step;
}

// ============================ 渲染卡片 ============================

function renderAll() {
  if (!cfg || !state) return;
  const L = cfg.layout;
  const lineEl = document.getElementById('line');
  lineEl.classList.toggle('hidden', !state.revealed);
  lineEl.classList.toggle('revealed', !!state.revealed);
  document.documentElement.style.setProperty('--panel-h', `${L.panelHeight}px`);
  lineEl.style.height = `${L.panelHeight}px`;

  const items = state.items || [];
  const seen = new Set();

  items.forEach((item, index) => {
    seen.add(item.fingerprint);
    let card = cards.get(item.fingerprint);
    if (!card) {
      card = createCard(item);
      cards.set(item.fingerprint, card);
      document.getElementById('cards').appendChild(card.el);
      // 新卡片：夹子从 +16° 弹回，卡片从上方落下。
      startSwing(card, 16, 46, 2.6);
      requestAnimationFrame(() => card.el.classList.add('arrived'));
    } else {
      updateCard(card, item);
    }
    card.index = index;
  });

  // 移除已经不在列表里的卡片
  for (const [fp, card] of [...cards]) {
    if (!seen.has(fp)) {
      card.el.remove();
      cards.delete(fp);
    }
  }

  // 位置
  const count = items.length;
  for (const card of cards.values()) {
    const x = xFor(card.index, count, L, state.visibleCount, state.scroll || 0);
    const y = ropeY(x, L) - L.pinAbove;
    card.el.style.left = `${x - L.cardWidth / 2}px`;
    card.el.style.top = `${y}px`;
    card.el.style.width = `${L.cardWidth}px`;
    const edge = Math.min(x, L.width - x);
    card.el.style.opacity = String(Math.min(1, Math.max(0, edge / 90)));
    card.copiedEl.classList.toggle('show', state.copiedPath === card.item.path);
  }

  // 空状态提示
  const empty = document.getElementById('empty');
  empty.classList.toggle('show', count === 0);
  if (count === 0) {
    empty.style.left = `${L.width / 2}px`;
    empty.style.top = `${ropeY(L.width / 2, L) + 34}px`;
  }

  scheduleRects();
}

function createCard(item) {
  const el = document.createElement('div');
  el.className = 'pegged';
  el.style.width = `${cfg.layout.cardWidth}px`;

  const arrive = document.createElement('div');
  arrive.className = 'arrive';
  el.appendChild(arrive);

  const pin = document.createElement('div');
  pin.className = 'pin';
  const position = cards.size; // 依次循环六色，相邻不重色
  pin.style.setProperty('--tint', PIN_PALETTE[position % PIN_PALETTE.length]);
  arrive.appendChild(pin);

  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  arrive.appendChild(cardEl);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  cardEl.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'name';
  cardEl.appendChild(name);

  const close = document.createElement('div');
  close.className = 'close';
  close.textContent = '✕';
  cardEl.appendChild(close);

  // “已复制文件”提示（对应 macOS 的 Label("已复制文件", systemImage: "checkmark")）。
  const copied = document.createElement('div');
  copied.className = 'copied glass';
  copied.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 6.4 4.6 9 10 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>已复制文件</span>';
  cardEl.appendChild(copied);

  const record = {
    fp: item.fingerprint,
    el, arrive, cardEl, thumb, nameEl: name, copiedEl: copied,
    tilt: (Math.random() * 5) - 2.5,
    swing: 0, swingSpring: null, gust: null,
    index: 0, item, hovering: false, dragging: false,
    thumbKey: null,
  };

  bindCardEvents(record);
  updateCard(record, item);
  return record;
}

function updateCard(card, item) {
  card.item = item;
  card.nameEl.textContent = middleTruncate(item.name, cfg.layout.cardWidth - 24);
  card.nameEl.title = item.name;
  const key = thumbKeyOf(item);
  if (card.thumbKey !== key) {
    card.thumbKey = key;
    loadThumbnail(card, item);
  }
}

function thumbKeyOf(item) {
  if (item.isDirectory) return 'dir';
  const ext = extOf(item.name);
  if (IMAGE_EXTS.has(ext)) return 'img:' + ext;
  if (VIDEO_EXTS.has(ext)) return 'vid:' + ext;
  if (ext === 'pdf') return 'pdf';
  return 'icon:' + ext;
}

async function loadThumbnail(card, item) {
  const thumb = card.thumb;
  thumb.className = 'thumb';
  thumb.textContent = '';
  const src = 'clothesfile://local/' + encodeURIComponent(item.path);
  const ext = extOf(item.name);

  if (!item.isDirectory && IMAGE_EXTS.has(ext)) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    thumb.appendChild(img);
    return;
  }

  if (!item.isDirectory && VIDEO_EXTS.has(ext)) {
    const video = document.createElement('video');
    video.src = src;
    video.muted = true;
    video.preload = 'auto';
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(0.15, (video.duration || 1) * 0.1); } catch { /* 忽略 */ }
    }, { once: true });
    thumb.appendChild(video);
    if (RECORDING_EXTS.has(ext)) {
      const play = document.createElement('div');
      play.className = 'play glass';
      play.textContent = '▶';
      thumb.appendChild(play);
    }
    return;
  }

  if (!item.isDirectory && ext === 'pdf') {
    thumb.classList.add('icon');
    const data = await api.pdfThumb(item.path);
    if (card.thumbKey !== thumbKeyOf(item)) return; // 卡片已更新
    if (data) {
      thumb.classList.remove('icon');
      const img = document.createElement('img');
      img.src = data;
      thumb.appendChild(img);
      return;
    }
    await loadSystemIcon(card, item);
    return;
  }

  await loadSystemIcon(card, item);
}

async function loadSystemIcon(card, item) {
  card.thumb.classList.add('icon');
  if (item.isDirectory) card.thumb.classList.add('dir');
  const data = await api.icon(item.path);
  const key = thumbKeyOf(item);
  if (card.thumbKey !== key) return;
  card.thumb.textContent = '';
  if (data) {
    const img = document.createElement('img');
    img.src = data;
    img.alt = '';
    card.thumb.appendChild(img);
  }
}

// ============================ 交互 ============================

function bindCardEvents(card) {
  const { cardEl, el } = card;
  let pendingSingle = null;
  let downPos = null;
  let pressedCross = false;

  cardEl.addEventListener('mouseenter', () => { card.hovering = true; cardEl.classList.add('hover'); });
  cardEl.addEventListener('mouseleave', () => { card.hovering = false; cardEl.classList.remove('hover'); });

  cardEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY };
    pressedCross = isOverClose(e, cardEl);
    cardEl.classList.add('pressed');
  });

  cardEl.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    cardEl.classList.remove('pressed');
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 5) return;
    if (pressedCross) {
      clearTimeout(pendingSingle);
      api.action('dismiss', { fingerprint: card.fp });
      return;
    }
    if (e.detail >= 2) {
      clearTimeout(pendingSingle);
      api.action('open', { path: card.item.path });
      return;
    }
    // 单击延迟 0.35 秒，让双击优先触发“打开”而不是预览。
    clearTimeout(pendingSingle);
    pendingSingle = setTimeout(() => api.action('quickLook', { path: card.item.path }), 350);
  });

  cardEl.addEventListener('click', (e) => e.stopPropagation());

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.contextMenu({ path: card.item.path, fingerprint: card.fp });
  });

  // 拖出真实文件（只提供复制，不移动源文件）。
  cardEl.addEventListener('dragstart', (event) => {
    event.preventDefault();
    clearTimeout(pendingSingle);
    cardEl.classList.add('dragging');
    el.classList.add('dragging');
    api.dragStart(card.item.path);
    setTimeout(() => { cardEl.classList.remove('dragging'); el.classList.remove('dragging'); }, 1200);
  });
}

function isOverClose(event, cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return x >= 0 && x < 28 && y >= 0 && y < 28;
}

function onWheel(event) {
  if (!state || !state.revealed) return;
  const delta = (event.deltaY || 0) + (event.deltaX || 0);
  if (delta) api.action('scroll', { delta });
}

// ============================ 命中区域上报（用于主进程判定点击穿透） ============================

function scheduleRects() {
  if (rectsScheduled) return;
  rectsScheduled = true;
  requestAnimationFrame(() => {
    rectsScheduled = false;
    const rects = [];
    for (const card of cards.values()) rects.push(offsetRect(card.el));
    const recent = document.getElementById('recentBtn');
    if (state && state.revealed) rects.push(offsetRect(recent));
    api.rects({ rects });
  });
}

/** 计算相对窗口的布局矩形（忽略 transform，保证隐藏状态下坐标依然正确）。 */
function offsetRect(el) {
  let x = 0;
  let y = 0;
  let node = el;
  while (node) {
    x += node.offsetLeft || 0;
    y += node.offsetTop || 0;
    node = node.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

// ============================ 小工具 ============================

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 中间省略（对应 Swift 的 .truncationMode(.middle)）。 */
function middleTruncate(text, maxWidth) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = '500 10px -apple-system, "Segoe UI", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif';
  if (measureCtx.measureText(text).width <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const head = Math.ceil(mid / 2);
    const tail = mid - head;
    const candidate = text.slice(0, head) + ell + (tail > 0 ? text.slice(text.length - tail) : '');
    if (measureCtx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const head = Math.ceil(lo / 2);
  const tail = lo - head;
  return text.slice(0, Math.max(1, head)) + ell + (tail > 0 ? text.slice(text.length - tail) : '');
}

boot();