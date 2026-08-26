# Changelog

## v0.2.1 (2026-08-26) — 自动升级首版

### 新增

- **自动升级**：走 GitHub Releases + electron-updater
  - `src/main/updater.ts`：定时检查 / 弹窗 / 下载 / `quitAndInstall`
  - 启动 30s 后 + 每小时一次后台检查 GitHub `latest.yml`
  - 托盘菜单「检查更新」+ 设置页「检查更新」按钮
  - 主进程弹独立 BrowserWindow 提示升级，支持「稍后 / 立即下载 / 立即重启并升级」
  - 升级记录写到 `%APPDATA%\本地总台\last-update-check.json`
- **GitHub Actions** (`.github/workflows/release.yml`)：tag 触发
  - `windows-latest` runner
  - `npm ci` → `npm run build` → `electron-builder --win portable --x64`
  - 产物：`local-console-{ver}-portable.exe` + `latest.yml` + `*.blockmap`
  - `softprops/action-gh-release` 自动上传到 GitHub Release
- **`scripts/` 一键启动/停止/状态/自启脚本**（v4）
  - `start.bat` / `stop.bat` / `status.bat` / `autostart.bat`
  - `start.ps1` / `stop.ps1` / `status.ps1`（PowerShell 版，更稳）
  - 自启动写注册表 `HKCU\...\Run\LocalConsole`，不需要管理员
  - 自检：自动拷贝 `build\icon.ico` 到 `dist\win-unpacked\resources\`（electron-builder bug workaround）
  - `fix_wincodesign.ps1`：剔除 winCodeSign 7z 里的 macOS darwin symlink（本地打 portable 必需）

### 改进

- **主进程**：
  - 静态 `import screen` 拿主显示器坐标（多显示器时窗口不再跑到不可见位置）
  - 集成 updater，托盘菜单加「检查更新」+「开机自启」分离
  - `slog` 容错改用 `appendFileSync`，避开 Node 22 兼容问题
- **preload**：暴露 `checkUpdate` / `getUpdateStatus` IPC
- **Settings.vue**：
  - 新增「自动升级」卡片：「检查更新」按钮 + 当前版本（从 updater 拿）+ 上次检查时间 + 结果
- **package.json**：
  - 加 `electron-updater@^6.8.9` 依赖
  - 新增 scripts：`release` / `dist:portable` / `dist:nsis` / `dist:dir`
  - `build.publish` 指向 `ppttfish/local-console`
  - 改 portable artifactName 为 ASCII：`local-console-${version}-portable.exe`（v0.2.1 旧名除外）
  - 删 nsis target（避开 winCodeSign bug，本地只打 portable）
- **README.md**：
  - 新增「自动升级」章节：发版流程 / 产物命名 / 常见坑 / 升级流程图 / 降级说明

### 已知问题

- **本地 `npm run dist:portable` 仍受 winCodeSign bug 影响**
  - 解决：跑 `scripts/fix_wincodesign.ps1` 预剔 darwin，或直接靠 GitHub Actions 跑
  - 第一次安装必须从 GitHub Releases 手动下 portable.exe
- **私仓 Actions 第一次跑需要开启**：Settings → Actions → Allow all workflows
- **portable 重启升级**：Squirrel 钩子需要旧版进程退出，新版才会启动。`quitAndInstall` 之后会闪一下

---

## v0.2.0 (2026-08-XX) — 上一版

（v0.2.0 之前没有结构化 changelog）
