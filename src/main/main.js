'use strict';

/**
 * Clothesline（Electron + Node.js 跨平台版）
 * 把刚刚下载完成的真实文件挂在屏幕顶部；Windows / Linux 效果一致。
 *
 * 主进程职责：
 *  - 管理顶部透明浮层窗口（可穿透点击、始终置顶、跟随鼠标所在屏幕）；
 *  - 监听下载目录并做“下载完成”门控；
 *  - 托盘菜单、全局快捷键、文件操作（打开/定位/复制/重命名/移到废纸篓）；
 *  - 通过 IPC 与渲染层（绳 / 夹子 / 卡片界面）通信。
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, clipboard,
  globalShortcut, dialog, protocol, net, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { Settings } = require('./settings');
const { Line } = require('./line');
const { FolderMonitors } = require('./folderMonitors');
const { ScreenshotMonitor } = require('./screenshotMonitor');

// WSL / root 环境下 Chromium 的 SUID 沙箱常常不可用，这里做一次兼容处理。
if (process.platform === 'linux' &&
    (process.env.WSL_DISTRO_NAME || (process.getuid && process.getuid() === 0))) {
  app.commandLine.appendSwitch('no-sandbox');
}

// ---- 自定义协议：把本地文件只读地暴露给渲染层（用于图片/视频/PDF 缩略图与预览） ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'clothesfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const SIZE_SCALES = { small: 0.8, medium: 1, large: 1.35 };
const KEEP_CHOICES = [0, 25, 50, 100];
const HOTKEY = 'Control+Alt+T';

/**
 * 构造指向本地文件的只读 URL。
 * 因为 clothesfile 是 standard scheme，`clothesfile:///abs` 会把首段当成主机名；
 * 这里固定主机为 `local`，把绝对路径整体编码后放进路径，保证 Windows / Linux 一致。
 */
function clothesfileURL(absPath) {
  return 'clothesfile://local/' + encodeURIComponent(absPath);
}

/**
 * 默认监控的“下载”目录。
 * Linux 上若未配置 XDG 下载目录，Electron 会回退到用户主目录，
 * 那会把整个家目录都挂上晾衣绳；这里改回 ~/Downloads，与 macOS 版一致。
 */
function defaultDownloadsFolder() {
  const downloads = app.getPath('downloads');
  const home = app.getPath('home');
  if (path.resolve(downloads) !== path.resolve(home)) return downloads;
  return path.join(home, 'Downloads');
}

/** 依据卡片尺寸计算整套布局（与 macOS 版 Layout 完全一致）。 */
function layoutFor(sizeKey, width) {
  const scale = SIZE_SCALES[sizeKey] ?? 1;
  const photoMaxHeight = Math.round(104 * scale);
  const cardWidth = Math.round(150 * scale);
  const spacing = cardWidth + 24;
  const panelHeight = photoMaxHeight + 112;
  const ropeTop = 10;
  const pinAbove = 9.5;
  const ropeStrip = { x: 0, y: 0, w: width, h: 34 }; // 绳子所在的顶部区域，作为放置目标
  return { scale, photoMaxHeight, cardWidth, spacing, panelHeight, ropeTop, pinAbove, width, ropeStrip };
}

class App {
  constructor() {
    this.settings = null;
    this.line = null;
    this.monitors = null;
    this.screenshots = null;
    this.win = null;
    this.drawerWin = null;
    this.previewWin = null;
    this.renameWin = null;
    this.tray = null;
    this.revealed = false;
    this.pinned = false;
    this.lastInside = 0;
    this.lastIgnore = null;
    this.interactiveRects = [];
    this.dragActive = false;
    this.currentDisplayId = null;
    this.scrollOffset = 0;
    this.monitoredFiles = [];
    this.screenshotFiles = [];
    this.copiedPath = null;
    this.copiedTimer = null;
    this.pollTimer = null;
    this.idleTimer = null;
  }

  // ============================ 启动 ============================

  start() {
    const userData = app.getPath('userData');
    this.settings = new Settings(path.join(userData, 'settings.json'));
    this.line = new Line(this.settings);
    this.line.restoreAttached();

    this.pinned = !!this.settings.get('alwaysShowLine');
    this.revealed = this.pinned;

    this.registerProtocol();
    this.createLineWindow();
    this.createTray();
    this.startHotkey();

    this.monitors = new FolderMonitors({
      defaultFolder: defaultDownloadsFolder(),
      onUpdate: (files) => { this.monitoredFiles = files; this.refreshFiles(); },
    });
    this.monitors.start();
    this.restoreMonitoredFolders();

    this.screenshots = new ScreenshotMonitor({
      folder: this.settings.get('screenshotFolder') || '',
      enabled: !!this.settings.get('screenshotMonitoring'),
    });
    this.screenshots.on('update', (files) => { this.screenshotFiles = files; this.refreshFiles(); });
    this.screenshots.on('failure', () => this.rebuildTrayMenu());
    this.screenshots.restart();

    this.recalculateCapacity();
    this.line.updateVisibleItems();
    this.pushState();

    // 指针轮询：跟随鼠标所在屏幕、悬停展开、离开收起、点击穿透。
    // 有卡片或已展开时 100ms 保证跟手；空绳子时降到 500ms，减少空闲唤醒。
    this.pollTimer = null;
    this.schedulePoll();
    // 长时间无操作后重建监听，兜底处理睡眠唤醒/事件丢失。
    this.idleTimer = setInterval(() => this.syncTrayState(), 15000);

    powerMonitor.on('resume', () => {
      this.monitors.wake();
      this.screenshots.restart();
    });
    powerMonitor.on('unlock-screen', () => {
      this.monitors.wake();
    });
  }

  registerProtocol() {
    protocol.handle('clothesfile', (request) => {
      try {
        const u = new URL(request.url);
        const filePath = decodeURIComponent(u.pathname.replace(/^\//, ''));
        // 仅允许读取真实存在的普通文件/目录，且不接受相对路径穿越。
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(abs).toString(), { bypassCustomProtocolHandlers: true });
      } catch (err) {
        return new Response('Bad request: ' + err.message, { status: 400 });
      }
    });
  }

  restoreMonitoredFolders() {
    const folders = this.settings.get('monitoredFolders') || [];
    for (const folder of folders) this.monitors.add(folder);
    this.rebuildTrayMenu();
  }

  // ============================ 顶部浮层窗口 ============================

  createLineWindow() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.currentDisplayId = display.id;
    const layout = layoutFor(this.settings.get('lineSize'), display.workArea.width);

    this.win = new BrowserWindow({
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: layout.panelHeight,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'line.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.lastIgnore = true;
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    this.win.once('ready-to-show', () => this.win.showInactive());
    this.win.on('closed', () => { this.win = null; });
  }

  placeOnDisplay(display) {
    if (!this.win) return;
    const layout = layoutFor(this.settings.get('lineSize'), display.workArea.width);
    this.win.setBounds({
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: layout.panelHeight,
    });
  }

  /** 屏幕可容纳的卡片数量（与 macOS 版 recalculateCapacity 一致）。 */
  recalculateCapacity() {
    const layout = this.currentLayout();
    const usable = Math.max(200, layout.width - 200);
    const fit = Math.max(3, Math.min(12, Math.floor(usable / layout.spacing)));
    this.line.visibleCount = fit;
    const keep = this.settings.getChoice('keepOnLine', KEEP_CHOICES, 0);
    this.line.maxItems = Math.max(fit, keep || fit);
  }

  currentLayout() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return layoutFor(this.settings.get('lineSize'), display.workArea.width);
  }

  // ============================ 指针轮询 & 显示逻辑 ============================

  /** 按当前状态安排下一次指针轮询（有内容时快、空闲时慢）。 */
  schedulePoll() {
    const hasCards = (this.line.items || []).length > 0;
    const delay = this.revealed || hasCards ? 100 : 500;
    this.pollTimer = setTimeout(() => {
      this.pollPointer();
      this.schedulePoll();
    }, delay);
  }

  pollPointer() {
    if (!this.win || this.win.isDestroyed()) return;
    // 拖拽/交互期间不要切换穿透，避免中断原生拖放。
    if (this.dragActive) {
      this.lastInside = Date.now();
      this.setIgnore(false);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    if (display.id !== this.currentDisplayId) {
      this.currentDisplayId = display.id;
      this.placeOnDisplay(display);
      this.recalculateCapacity();
      this.pushState();
    }
    const work = display.workArea;
    const local = { x: cursor.x - work.x, y: cursor.y - work.y };
    const atTop = cursor.y >= work.y - 1 && cursor.y <= work.y + 4;
    const overPanel = local.x >= 0 && local.x <= work.width && local.y >= 0 && local.y <= this.currentLayout().panelHeight;
    const overInteractive = this.isOverInteractive(local);

    if (atTop || (this.revealed && (overPanel || overInteractive))) {
      this.lastInside = Date.now();
    }
    const shouldReveal = this.pinned || (Date.now() - this.lastInside < 750);
    if (shouldReveal !== this.revealed) {
      this.revealed = shouldReveal;
      this.pushState();
    }
    this.setIgnore(!shouldReveal || !overInteractive);
  }

  isOverInteractive(local) {
    const rope = this.currentLayout().ropeStrip;
    const inRect = (r) => local.x >= r.x - 4 && local.x <= r.x + r.w + 4 &&
      local.y >= r.y - 4 && local.y <= r.y + r.h + 4;
    if (inRect(rope)) return true;
    return this.interactiveRects.some(inRect);
  }

  setIgnore(ignore) {
    if (ignore === this.lastIgnore || !this.win || this.win.isDestroyed()) return;
    this.lastIgnore = ignore;
    this.win.setIgnoreMouseEvents(ignore, { forward: true });
    this.win.webContents.send('line:pointer', { ignore });
  }

  setPinned(enabled) {
    this.pinned = enabled;
    this.settings.set('alwaysShowLine', enabled);
    if (enabled) {
      this.revealed = true;
      this.placeOnDisplay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    } else {
      this.lastInside = 0;
      this.revealed = false;
    }
    this.pushState();
    this.rebuildTrayMenu();
  }

  startHotkey() {
    try {
      globalShortcut.register(HOTKEY, () => this.setPinned(!this.pinned));
    } catch (err) {
      console.error('[hotkey] 注册失败:', err.message);
    }
  }

  // ============================ 状态推送 ============================

  pushState() {
    if (!this.win || this.win.isDestroyed()) return;
    const layout = this.currentLayout();
    this.win.webContents.send('line:config', {
      layout,
      size: this.settings.getChoice('lineSize', ['small', 'medium', 'large'], 'medium'),
      keepOnLine: this.settings.getChoice('keepOnLine', KEEP_CHOICES, 0),
    });
    this.win.webContents.send('line:state', {
      items: this.line.items || [],
      revealed: this.revealed,
      visibleCount: this.line.visibleCount,
      scroll: this.scrollOffset,
      pinned: this.pinned,
      copiedPath: this.copiedPath,
    });
  }

  refreshFiles() {
    const unique = new Map();
    for (const f of [...this.monitoredFiles, ...this.screenshotFiles]) unique.set(f.path, f);
    const files = [...unique.values()].sort((a, b) => {
      const ra = a.added ?? a.created; const rb = b.added ?? b.created;
      return rb - ra;
    });
    this.line.adopt(files);
    this.pushState();
  }

  // ============================ 托盘菜单 ============================

  createTray() {
    const iconPath = path.join(__dirname, '..', '..', 'Clothesline', 'assets', 'clothesline-icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
    this.tray = new Tray(image);
    this.tray.setToolTip('Clothesline · 晾衣绳');
    this.tray.on('click', () => this.setPinned(!this.pinned));
    this.rebuildTrayMenu();
  }

  rebuildTrayMenu() {
    if (!this.tray) return;
    const template = [];
    template.push({ label: '晾衣绳 · Clothesline', enabled: false });
    for (const folder of this.monitors ? this.monitors.folders : []) {
      template.push({ label: `监控：${path.basename(folder)}`, enabled: false, toolTip: folder });
      const failure = this.monitors.failures.get(folder);
      if (failure) template.push({ label: `⚠ ${failure}`, enabled: false });
    }
    template.push({ type: 'separator' });
    template.push({ label: '一直显示晾衣绳', type: 'checkbox', checked: this.pinned,
      click: () => this.setPinned(true) });
    template.push({ label: '自动隐藏晾衣绳', type: 'checkbox', checked: !this.pinned,
      click: () => this.setPinned(false) });
    template.push({ label: '挂上文件或文件夹…', click: () => this.attachFilesDialog() });
    template.push({ label: '最近文件…', click: () => this.showRecentDrawer() });
    template.push({ label: '接入截图文件', type: 'checkbox',
      checked: !!this.settings.get('screenshotMonitoring'),
      click: () => {
        const next = !this.settings.get('screenshotMonitoring');
        this.settings.set('screenshotMonitoring', next);
        this.screenshots.setEnabled(next);
        this.rebuildTrayMenu();
      } });
    template.push({ label: '选择截图保存文件夹…', click: () => this.chooseScreenshotFolder() });
    if (this.screenshots && this.screenshots.failure) {
      template.push({ label: `截图监控：${this.screenshots.failure}`, enabled: false });
    }
    template.push({ label: '打开下载文件夹', click: () => shell.openPath(defaultDownloadsFolder()) });
    template.push({ label: '添加监控文件夹…', click: () => this.addMonitorFolders() });
    template.push({ type: 'separator' });

    const keepValue = this.settings.getChoice('keepOnLine', KEEP_CHOICES, 0);
    template.push({ label: '保留文件数量', submenu: [0, 25, 50, 100].map((choice) => ({
      label: choice === 0 ? '屏幕可容纳数量' : `${choice} 个文件`,
      type: 'radio',
      checked: keepValue === choice,
      click: () => {
        this.settings.set('keepOnLine', choice);
        this.recalculateCapacity();
        this.line.updateVisibleItems();
        this.pushState();
        this.rebuildTrayMenu();
      },
    })) });

    const sizeValue = this.settings.getChoice('lineSize', ['small', 'medium', 'large'], 'medium');
    template.push({ label: '卡片尺寸', submenu: [
      ['small', '小'], ['medium', '中'], ['large', '大'],
    ].map(([key, label]) => ({
      label, type: 'radio', checked: sizeValue === key,
      click: () => {
        this.settings.set('lineSize', key);
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        this.placeOnDisplay(display);
        this.recalculateCapacity();
        this.line.updateVisibleItems();
        this.pushState();
        this.rebuildTrayMenu();
      },
    })) });

    template.push({ type: 'separator' });
    template.push({ label: '清空晾衣绳（不删除文件）', click: () => {
      this.line.dismissAll(); this.scrollOffset = 0; this.pushState();
    } });
    template.push({ label: '重新显示已取下的文件', click: () => {
      this.line.resetDismissed(); this.pushState();
    } });
    template.push({ type: 'separator' });
    template.push({ label: `快捷键：${HOTKEY.replace('Control', 'Ctrl').replace('+', '+').replace('Alt', 'Opt')}`, enabled: false });
    template.push({ label: '退出 Clothesline', click: () => app.quit() });

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  syncTrayState() {
    // 兜底：让菜单勾选状态与设置保持一致。
    if (!this.tray) return;
    if (this.settings.get('alwaysShowLine') !== this.pinned) this.rebuildTrayMenu();
  }

  // ============================ 文件选择 / 对话框 ============================

  async addMonitorFolders() {
    const result = await dialog.showOpenDialog({
      title: '添加监控文件夹',
      message: '新文件夹与“下载”目录同时监控，不会替换已有监控。',
      defaultPath: defaultDownloadsFolder(),
      properties: ['openDirectory', 'multiSelections'],
      buttonLabel: '添加监控文件夹',
    });
    if (result.canceled) return;
    const folders = this.settings.get('monitoredFolders') || [];
    for (const folder of result.filePaths) {
      this.monitors.add(folder);
      if (!folders.includes(folder)) folders.push(folder);
    }
    this.settings.set('monitoredFolders', folders);
    this.rebuildTrayMenu();
  }

  async attachFilesDialog() {
    const result = await dialog.showOpenDialog({
      title: '挂上晾衣绳',
      message: '挂上文件或文件夹快捷入口，保留在原位置；“下载”监听仍然继续。',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      buttonLabel: '挂上晾衣绳',
    });
    if (result.canceled) return;
    this.attachPaths(result.filePaths);
  }

  attachPaths(paths) {
    if (this.line.attachPaths(paths)) {
      this.scrollOffset = 0;
      this.revealed = true;
      this.lastInside = Date.now();
      this.pushState();
    } else {
      this.pushState();
    }
  }

  async chooseScreenshotFolder() {
    const result = await dialog.showOpenDialog({
      title: '选择截图保存文件夹',
      message: '仅识别截图文件，不修改系统截图设置。',
      defaultPath: this.screenshots ? this.screenshots.resolveFolder() : app.getPath('pictures'),
      properties: ['openDirectory'],
      buttonLabel: '选择',
    });
    if (result.canceled || !result.filePaths[0]) return;
    this.settings.set('screenshotFolder', result.filePaths[0]);
    this.settings.set('screenshotMonitoring', true);
    this.screenshots.setFolder(result.filePaths[0]);
    this.rebuildTrayMenu();
  }

  // ============================ 卡片操作 ============================

  async handleAction(name, payload = {}) {
    switch (name) {
      case 'quickLook': return this.openPreview(payload.path);
      case 'open': return this.openPath(payload.path);
      case 'reveal': shell.showItemInFolder(payload.path); return;
      case 'copy': {
        copyFileToClipboard(payload.path);
        // 与 macOS 一致：卡片下方短暂显示“已复制文件”提示。
        this.copiedPath = payload.path;
        this.pushState();
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => { this.copiedPath = null; this.pushState(); }, 1100);
        return { copied: true };
      }
      case 'dismiss': this.line.dismiss(payload.fingerprint); this.pushState(); return;
      case 'attachFiles': this.attachPaths(payload.paths || []); return;
      case 'scroll': {
        const layout = this.currentLayout();
        const limit = Math.max(0, (this.line.items || []).length - this.line.visibleCount) * layout.spacing;
        this.scrollOffset = Math.min(limit, Math.max(0, this.scrollOffset + (payload.delta || 0)));
        this.pushState();
        return;
      }
      case 'rename': return this.renameCard(payload);
      case 'trash': return this.trashCard(payload);
      case 'share': return this.shareCard(payload);
      case 'showRecent': this.showRecentDrawer(); return;
      case 'openDownloads': shell.openPath(defaultDownloadsFolder()); return;
      case 'togglePinned': this.setPinned(!this.pinned); return;
      default: return { ok: false, error: `未知操作：${name}` };
    }
  }

  async openPath(targetPath) {
    const err = await shell.openPath(targetPath);
    if (err) this.showError(err);
  }

  async renameCard({ path: targetPath, fingerprint }) {
    const item = (this.line.items || []).find((i) => i.path === targetPath);
    if (!item) return { ok: false };
    const stem = path.extname(item.name) && !item.isDirectory
      ? item.name.slice(0, item.name.length - path.extname(item.name).length)
      : item.name;
    const value = await this.promptWindow({
      title: `重命名“${item.name}”`,
      message: '修改原文件名称，文件扩展名保持不变。',
      value: stem,
      okLabel: '重命名',
    });
    if (value == null) return { ok: false, canceled: true };
    const result = this.line.rename(targetPath, fingerprint, value);
    if (!result.ok) { this.showError(result.error); return result; }
    this.pushState();
    return result;
  }

  async trashCard({ path: targetPath, fingerprint }) {
    const item = (this.line.items || []).find((i) => i.path === targetPath);
    if (!item) return { ok: false };
    const detail = item.isDirectory
      ? '文件夹及其内容会从原位置移到系统回收站，可以恢复。若只想隐藏卡片，请选择“从晾衣绳取下”。'
      : '原文件会移到系统回收站，可以恢复。若只想隐藏卡片，请选择“从晾衣绳取下”。';
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '移到废纸篓',
      message: `将“${item.name}”移到废纸篓？`,
      detail,
      buttons: ['取消', '移到废纸篓'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, canceled: true };
    const result = await this.line.moveToTrash(targetPath, fingerprint, (p) => shell.trashItem(p));
    if (!result.ok) { this.showError(result.error); return result; }
    this.pushState();
    return result;
  }

  shareCard({ path: targetPath }) {
    // macOS 的 NSSharingServicePicker 在 Windows/Linux 没有等价物，
    // 这里给出跨平台一致的“分享”动作集合。
    const item = (this.line.items || []).find((i) => i.path === targetPath);
    if (!item) return { ok: false };
    this.popupMenu([
      { label: '复制文件路径', click: () => clipboard.writeText(targetPath) },
      { label: '通过邮件发送…', click: () => {
        const subject = encodeURIComponent(item.name);
        shell.openExternal(`mailto:?subject=${subject}&body=${encodeURIComponent(pathToFileURL(targetPath).toString())}`)
          .catch(() => {});
      } },
      { label: '在文件管理器中显示', click: () => shell.showItemInFolder(targetPath) },
    ]);
    return { ok: true };
  }

  /** 在鼠标位置弹出原生菜单（可超出浮层窗口范围）。 */
  popupMenu(template) {
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: this.win || undefined });
  }

  /** 卡片右键菜单（与 macOS 版条目一致）。 */
  showCardMenu(targetPath, fingerprint) {
    const act = (name, payload) => this.handleAction(name, payload);
    this.popupMenu([
      { label: '快速预览', click: () => act('quickLook', { path: targetPath }) },
      { label: '打开文件', click: () => act('open', { path: targetPath }) },
      { label: '在文件管理器中显示', click: () => act('reveal', { path: targetPath }) },
      { label: '复制文件', click: () => act('copy', { path: targetPath }) },
      { label: '重命名…', click: () => act('rename', { path: targetPath, fingerprint }) },
      { label: '分享…', click: () => act('share', { path: targetPath }) },
      { type: 'separator' },
      { label: '从晾衣绳取下（保留原文件）', click: () => act('dismiss', { fingerprint }) },
      { label: '移到废纸篓…', click: () => act('trash', { path: targetPath, fingerprint }) },
    ]);
  }

  showError(message) {
    dialog.showMessageBox({ type: 'error', title: 'Clothesline', message: String(message), buttons: ['好'], noLink: true });
  }

  // ============================ 子窗口：最近文件 / 预览 / 重命名 ============================

  showRecentDrawer() {
    if (this.drawerWin && !this.drawerWin.isDestroyed()) {
      this.drawerWin.show();
      this.drawerWin.focus();
      return;
    }
    this.drawerWin = new BrowserWindow({
      width: 560,
      height: 480,
      minWidth: 420,
      minHeight: 320,
      title: '最近文件',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'drawer.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    this.drawerWin.setMenuBarVisibility(false);
    this.drawerWin.loadFile(path.join(__dirname, '..', 'renderer', 'drawer.html'));
    this.drawerWin.on('closed', () => { this.drawerWin = null; });
  }

  openPreview(targetPath) {
    if (this.previewWin && !this.previewWin.isDestroyed()) this.previewWin.close();
    const fileUrl = clothesfileURL(targetPath);
    this.previewWin = new BrowserWindow({
      width: 900,
      height: 680,
      title: path.basename(targetPath),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    this.previewWin.setMenuBarVisibility(false);
    this.previewWin.loadFile(path.join(__dirname, '..', 'renderer', 'preview.html'),
      { query: { src: fileUrl, name: path.basename(targetPath), path: targetPath } });
    this.previewWin.on('closed', () => { this.previewWin = null; });
  }

  promptWindow({ title, message, value, okLabel }) {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 420,
        height: 190,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: title || 'Clothesline',
        parent: undefined,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'prompt.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
        },
      });
      win.setMenuBarVisibility(false);
      win.loadFile(path.join(__dirname, '..', 'renderer', 'prompt.html'),
        { query: { title: title || '', message: message || '', value: value || '', ok: okLabel || '确定' } });
      const onResult = (_e, result) => {
        ipcMain.removeListener('prompt:result', onResult);
        if (!win.isDestroyed()) win.close();
        resolve(result);
      };
      ipcMain.on('prompt:result', onResult);
      win.on('closed', () => {
        ipcMain.removeListener('prompt:result', onResult);
        resolve(null);
      });
      win.once('ready-to-show', () => win.show());
    });
  }
}

// ============================ 应用生命周期 ============================

const instance = new App();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (instance.win) instance.win.showInactive(); });

  app.whenReady().then(() => {
    instance.start();

    // 渲染层 → 主进程
    ipcMain.handle('line:init', () => ({
      layout: instance.currentLayout(),
      size: instance.settings.getChoice('lineSize', ['small', 'medium', 'large'], 'medium'),
      keepOnLine: instance.settings.getChoice('keepOnLine', KEEP_CHOICES, 0),
      state: {
        items: instance.line.items || [],
        revealed: instance.revealed,
        visibleCount: instance.line.visibleCount,
        scroll: instance.scrollOffset,
        pinned: instance.pinned,
        copiedPath: instance.copiedPath,
      },
    }));
    ipcMain.handle('line:action', (_e, { name, payload }) => instance.handleAction(name, payload));
    ipcMain.on('line:rects', (_e, payload) => {
      instance.interactiveRects = Array.isArray(payload.rects) ? payload.rects : [];
    });
    ipcMain.on('line:dragState', (_e, active) => {
      instance.dragActive = !!active;
    });
    ipcMain.on('line:contextMenu', (_e, { path: p, fingerprint }) => {
      instance.showCardMenu(p, fingerprint);
    });
    ipcMain.on('line:dragStart', (event, { path: filePath }) => {
      startFileDrag(event, filePath);
    });
    ipcMain.handle('drawer:list', (_e, { query }) => instance.line.recentFiles(query || ''));
    ipcMain.handle('drawer:action', (_e, { name, payload }) => instance.handleAction(name, payload));
    ipcMain.handle('preview:icon', (_e, { path: p }) => getIconDataURL(p));
    ipcMain.handle('preview:open', (_e, { path: p }) => instance.openPath(p));
    ipcMain.handle('preview:reveal', (_e, { path: p }) => shell.showItemInFolder(p));
    ipcMain.handle('preview:readText', (_e, { path: p }) => readTextFile(p));
    ipcMain.handle('line:icon', (_e, { path: p }) => getIconDataURL(p));
    ipcMain.handle('line:pdfThumb', (_e, { path: p }) => renderPdfThumbnail(p));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) instance.createLineWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：窗口关闭不退出应用，退出由托盘菜单负责。
  });

  app.on('before-quit', () => {
    if (instance.monitors) instance.monitors.stop();
    if (instance.screenshots) instance.screenshots.stop();
    if (instance.pollTimer) clearTimeout(instance.pollTimer);
    if (instance.idleTimer) clearInterval(instance.idleTimer);
    globalShortcut.unregisterAll();
  });
}

/** 原生文件拖出（复制），Windows/Linux 都走 Electron 的 startDrag。 */
function startFileDrag(event, filePath) {
  try {
    const icon = nativeImage.createFromPath(filePath);
    const dragIcon = icon.isEmpty()
      ? nativeImage.createFromPath(path.join(__dirname, '..', '..', 'Clothesline', 'assets', 'clothesline-icon.png')).resize({ width: 64 })
      : icon.resize({ width: 64 });
    event.sender.startDrag({ file: filePath, icon: dragIcon });
  } catch (err) {
    console.error('[drag] 失败:', err.message);
  }
}

/**
 * 系统文件图标（用于非图片/视频/PDF 的类型与文件夹）。
 * 按路径缓存：重渲染、绳子与抽屉同时显示同一文件时不再重复调用原生接口。
 */
const iconCache = new Map();
const ICON_CACHE_MAX = 256;

async function getIconDataURL(targetPath) {
  const cached = iconCache.get(targetPath);
  if (cached) return cached;
  let result = null;
  try {
    const icon = await app.getFileIcon(targetPath, { size: 'large' });
    if (!icon.isEmpty()) result = icon.toDataURL();
  } catch {
    // 个别 Linux 桌面缺少图标主题时 getFileIcon 会失败，走下面的内置图标兜底。
  }
  if (!result) result = isDirectory(targetPath) ? FOLDER_ICON_DATAURL : FILE_ICON_DATAURL;
  if (iconCache.size >= ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
  iconCache.set(targetPath, result);
  return result;
}

// 内置矢量图标（data URL），保证 Windows / Linux 在系统图标不可用时也能看到图标。
const FOLDER_ICON_DATAURL = svgDataURL(`<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 12a3 3 0 0 1 3-3h11l4 4h17a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#79a8dc"/>
  <path d="M5 17h38v20a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#9cc2ea"/>
</svg>`);

const FILE_ICON_DATAURL = svgDataURL(`<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 5h16l10 10v28a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="#ffffff" stroke="#c3c8d0" stroke-width="2"/>
  <path d="M28 5v10h10" fill="#e6e9ee" stroke="#c3c8d0" stroke-width="2"/>
  <path d="M16 24h16M16 30h16M16 36h10" stroke="#c3c8d0" stroke-width="2" stroke-linecap="round"/>
</svg>`);

function svgDataURL(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function isDirectory(targetPath) {
  try { return fs.statSync(targetPath).isDirectory(); } catch { return false; }
}

/** 读取文本文件内容（预览窗口用）；最多读取 1MB，失败或非普通文件返回 null。 */
function readTextFile(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(targetPath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 把文件放进系统剪贴板。
 * macOS 版用 pb.writeObjects([url]) 复制“文件本身”，可在 Finder 里直接粘贴成副本；
 * Electron 的 clipboard 只暴露 text/html/image/rtf/bookmark，没有跨平台的“文件对象”写入接口，
 * 因此这里退化为写入文件的绝对路径文本（可在文本框/终端粘贴），
 * 界面上的“已复制文件”提示与 macOS 版保持一致。
 */
function copyFileToClipboard(targetPath) {
  clipboard.clear();
  clipboard.writeText(targetPath);
}

// ---- PDF 缩略图：用 Chromium 自带的 PDF 渲染器截取第一页，Windows/Linux 完全一致 ----
const pdfThumbCache = new Map();
let pdfQueue = Promise.resolve();

function renderPdfThumbnail(filePath) {
  const job = async () => {
    let st;
    try { st = fs.statSync(filePath); } catch { return ''; }
    const key = `${filePath}|${st.mtimeMs}`;
    if (pdfThumbCache.has(key)) return pdfThumbCache.get(key);
    const win = new BrowserWindow({
      show: false,
      width: 520,
      height: 700,
      webPreferences: { sandbox: false, backgroundThrottling: false },
    });
    try {
      await win.loadURL(clothesfileURL(filePath));
      const image = await captureWhenReady(win);
      if (!image || image.isEmpty()) return '';
      const data = image.resize({ width: 240 }).toDataURL();
      pdfThumbCache.set(key, data);
      return data;
    } catch {
      return '';
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  };
  // 串行执行，避免同时创建多个隐藏窗口。
  pdfQueue = pdfQueue.then(job, job);
  return pdfQueue;
}

/** 等待 PDF 渲染出内容后再截图；若仍是空白则重试。 */
async function captureWhenReady(win) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(220);
    if (win.isDestroyed()) return null;
    let image;
    try { image = await win.webContents.capturePage(); } catch { return null; }
    if (image && !image.isEmpty() && !isMostlyBlank(image)) return image;
  }
  // 全部重试都偏白时，仍返回最后一次结果（可能是空白页 PDF）。
  try { return await win.webContents.capturePage(); } catch { return null; }
}

/** 粗略判断截屏是否几乎全白/全空。 */
function isMostlyBlank(image) {
  try {
    const size = image.getSize();
    if (!size.width || !size.height) return true;
    const bmp = image.toBitmap(); // BGRA
    let dark = 0;
    let total = 0;
    for (let i = 0; i + 3 < bmp.length; i += 4 * 97) {
      total++;
      const avg = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
      if (avg < 210) dark++;
    }
    return total === 0 || dark / total < 0.003;
  } catch {
    return true;
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }