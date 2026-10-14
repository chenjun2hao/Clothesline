# Clothesline · 晾衣绳（Electron + Node.js 跨平台版）

说明：Clothesline 是 [Clothesline/](https://github.com/zhongguozhang/Clothesline) 的跨平台 Electron 版，目标是在 Windows / Linux 上提供与 macOS 版一致的用户体验。使用trac + deepseek-v4.1-flash 模型进行代码生成。

效果：

<video src="doc/Clothesline-demo.mp4" controls width="720"></video>

> 若预览器不支持内嵌播放，点这里：[doc/Clothesline-demo.mp4](doc/Clothesline-demo.mp4)

使用：
- windows
下载[Clothesline-0.2.0-win.zip](https://github.com/chenjun2hao/Clothesline/releases/tag/0.2.0)，解压后运行Clothesline.exe即可。

- linux(未验证)
下载[clothesline_0.2.0_amd64.deb](https://github.com/chenjun2hao/Clothesline/releases/tag/0.2.0)，安装使用。


## 总览

把**刚刚下载完成**的真实文件，以玻璃小卡片的形式挂在屏幕顶部的一条晾衣绳上。
鼠标移到屏幕顶部时绳子展开，移开后自动收起；点一下预览，双击用默认应用打开。

- 目标平台：**Windows / Linux**，两端的视觉与交互保持一致。
- 行为与观感对齐 macOS 原版（[zhongguozhang/Clothesline](https://github.com/zhongguozhang/Clothesline)，Swift 源码，未修改）。
- 只负责“显示与入口”：**取下 / 清空 / 退出都不会删除源文件**；只有右键菜单里明确选择“移到废纸篓”并确认后，才会把文件移入系统回收站（可恢复）。

## 目录结构

```
src/
  main/                  主进程（Node 环境）
    main.js              悬浮窗 / 托盘 / 快捷键 / 文件操作 / IPC
    line.js              晾衣绳的“文件列表模型”（取下、挂上、重命名、移入回收站）
    downloadIndex.js     目录扫描、临时后缀过滤、下载完成度门控、指纹
    folderMonitors.js    多目录监听（fs.watch + 2 秒轮询兜底）
    screenshotMonitor.js 截图文件监听
    settings.js          设置读写（原子写入）
  preload/               contextBridge 暴露给渲染层的最小接口
  renderer/              界面：绳子、夹子、卡片、动画、预览、抽屉、重命名
tests/                   基于 Node 内置 test runner 的单元测试
doc/                     演示视频
build/icons/             Linux 打包用的标准尺寸图标
Clothesline/assets/      应用图标（托盘 / 安装包图标来源）
```

## 环境要求

- Node.js 18+（开发时使用 v24）
- 依赖只有 Electron（`devDependencies`）

## 安装与运行

```bash
npm install          # 安装依赖（会下载 Electron 二进制）
```

### Windows

```bash
npm start
```

### Linux

**方式一：从源码运行**

```bash
npm start            # 正常桌面环境
npm run start:linux  # 若遇到沙箱/显卡相关报错，用这个脚本
```

**方式二：用安装包**（由 `npm run dist:linux` 产出，见下文「打包为安装包」）

AppImage —— 免安装，推荐：

```bash
chmod +x Clothesline-0.2.0.AppImage
./Clothesline-0.2.0.AppImage
```

deb（Debian / Ubuntu）：

```bash
sudo dpkg -i clothesline_0.2.0_amd64.deb
sudo apt-get -f install    # 若提示缺依赖，用这行补齐
clothesline                # 启动
```

卸载 deb：

```bash
sudo dpkg -r clothesline
```

deb 会把程序装到 `/opt/Clothesline/`，图标装进 `hicolor` 标准尺寸目录，
应用菜单里可以直接看到 Clothesline。

启动后程序常驻托盘（托盘图标：`Clothesline/assets/clothesline-icon.png`）：

- 单击托盘图标 = 切换“一直显示 / 自动隐藏”；
- 右键托盘图标 = 完整菜单（监控目录、最近文件、卡片尺寸、保留数量、清空、退出等）；
- 全局快捷键 **Ctrl + Alt + T** = 切换“一直显示”。

用户设置保存在 Electron 的 `userData` 目录：

- Windows：`%APPDATA%\clothesline\settings.json`
- Linux：`~/.config/clothesline/settings.json`

## Linux 常见问题

1. **缺少系统库，Electron 起不来**（提示 `error while loading shared libraries`）
   安装 Electron 需要的运行库（体积小，一次性）：

   ```bash
   sudo apt-get install -y libnspr4 libnss3 libasound2 libgbm1 libxss1 \
     libgtk-3-0 libnss3 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
     libpango-1.0-0 libcairo2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libatspi2.0-0
   ```

   没有 sudo 权限时，也可以把对应 `.deb` 下载后用 `dpkg-deb -x` 解到本地目录，再用
   `LD_LIBRARY_PATH=<解包目录>/usr/lib/x86_64-linux-gnu` 启动。

2. **托盘图标不显示**
   Electron 托盘在 Linux 依赖桌面环境的 StatusNotifier/AppIndicator 支持。若当前桌面不提供，
   菜单入口会不可见，但功能仍可用；可给桌面安装 AppIndicator 扩展。

3. **窗口透明/置顶异常**
   透明无边框窗口需要窗口合成器。GNOME/KDE 等常规桌面默认支持；纯 X11 无合成器的极简环境可能不生效。

4. **WSL / 无显示器环境**
   这类环境通常没有可用 GPU，需要软件渲染：

   ```bash
   npx electron . --no-sandbox --disable-gpu --disable-dev-shm-usage
   ```

5. **没有配置 XDG 下载目录**
   此时系统“下载”目录会解析成用户主目录。程序在这种情况下会退回 `~/Downloads`，
   避免把整个家目录挂上晾衣绳。

## 功能与 macOS 原版对齐

- **过滤**：忽略 `.crdownload / .download / .part / .tmp` 等临时后缀与隐藏文件；存在临时兄弟文件时不显示目标文件。
- **完成判定**：连续两次 stat 一致 + 2 秒静默期才算“下载完成”。
- **顶部浮层**：绳子用二次贝塞尔下垂；六色夹子循环配色、相邻不重色；卡片随机 -2.5°~2.5° 倾斜、悬停展开、移开 0.75 秒收起。
- **卡片交互**：单击 = 预览（延迟 0.35 秒让双击优先）；双击 = 默认应用打开；右键 = 菜单；可以拖出真实文件（复制），也可以把文件拖进来挂上（不移动原文件）。
- **菜单项**：快速预览 / 打开 / 在文件管理器中显示 / 复制 / 重命名 / 分享 / 从晾衣绳取下 / 移到废纸篓。
- **最近文件抽屉**：最多 200 条，可搜索、挂上、拖出。
- **卡片尺寸**：小 0.8 / 中 1 / 大 1.35 倍。

> 两端“效果一致”依赖统一的渲染路径：图片/视频直接用 Chromium 渲染，
> PDF 缩略图与预览用 Chromium 内置 PDF 引擎（同一套渲染器），
> 因此 Windows 与 Linux 的表现一致。

## 测试

```bash
npm test
```

覆盖下载目录扫描、临时后缀过滤、完成度门控、指纹变化等纯逻辑（Node 内置 test runner）。

## 打包为安装包

项目已内置 electron-builder 配置（`package.json` 的 `build` 字段），产物输出到 `dist/`：

```bash
npm run dist:win     # Windows（NSIS 安装包）
npm run dist:linux   # Linux（AppImage / deb）
```

首次运行会联网下载对应平台的 Electron 运行时与打包工具。

产物：

| 命令 | 产物 |
|---|---|
| `npm run dist:linux` | `dist/Clothesline-<版本>.AppImage`、`dist/clothesline_<版本>_amd64.deb` |
| `npm run dist:win` | `dist/Clothesline Setup <版本>.exe`（NSIS 安装包） |

### 在 Linux 上打 Windows 包的限制

Windows 安装包（NSIS）的最后一步需要 **wine** 来写入 exe 图标与版本信息，Linux 上未装 wine 时会报
`wine is required`。此时有两种做法：

- 安装 wine 后正常出安装包；
- 或只出免安装 zip（无需 wine）：

```bash
npx electron-builder --win --x64 --publish never \
  -c.win.target=zip -c.win.signAndEditExecutable=false
```

产物：`dist/win-unpacked/`（可直接运行）与 `dist/Clothesline-<版本>-win.zip`。
其中 `signAndEditExecutable=false` 表示跳过 exe 图标/版本写入，因此 zip 里的 exe 是 Electron 默认图标；
在 Windows 或装了 wine 的机器上正常打 NSIS 包时会自动带上图标。

> 若在本机直接跑 `npx electron-builder --win` 时报 `FATAL: main argv conversion failed!`，
> 多半是当前 `LANG` 指向了系统不存在的 locale，把 `LANG`/`LC_ALL` 设为 `C.utf8` 即可。