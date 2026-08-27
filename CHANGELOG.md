# Changelog

## v0.2.3 (2026-08-27) — 启动台外部接管 + 订阅卡片重构 + 网页端控制修复

### 修复

- **订阅监控卡片**
  - z.ai MCP Tools 窗口重置时间缺秒→毫秒换算，倒计时可能按 1970 年计算
  - 用量 ≥90% 时主进度条透明不可见（danger 态缺 background）
  - 卡片重构：大百分比标注口径窗口（如「5h 窗口 · 用量最高」）+ 重置倒计时；
    明细轨道可见、用量最高窗口加「最高」标记；状态与配额余量语义分离；
    操作按钮统一幽灵风格；通用单窗条目展示已用/剩余
- **启动台 / 外部接管**
  - 端口被外部进程占用时显示「外部运行中」+ 进程名与 PID，不再误显示「已停止」
  - 新增「结束进程」/「重启接管」：仅允许结束当前监听该端口的进程（杀前校验 PID 存活）
  - 主动停止不再误标「失败」（Windows taskkill 强杀退出码为 1）
  - 新增卡片「编辑」入口；接管回填的进程完整命令行会被拦截并提示改成可执行命令
- **网页端**
  - 修复启动/停止/重启 404：web 桥接无 body 时退化为 GET，而控制路由只认 POST
  - 补 `/api/service/get`、`/api/service/clear-logs` 路由（清空日志网页端原为 404）
- **样式**：亮色主题下 primary 按钮 hover 白字浅底不可读

### 改进

- 服务操作失败以右下角 toast 提示具体原因，不再静默无反馈

## v0.2.2 (2026-08-27) — 订阅监控 Tab + 11 个 Provider 适配

### 新增

- **Token 用量页「订阅监控」Tab**（双 Tab 布局，原有图表零改动）
  - 顶部 Tab 切换：「Token 用量」/「订阅监控」+ 数量徽标
  - 订阅卡片：logo/品牌色 + 状态 tag（正常/未同步/异常）+ 多窗口明细
  - 主进度条 = 最紧急窗口；每窗口独立行：标签/进度条/百分比/重置倒计时
  - 卡片操作：刷新 / 编辑 / 删除；删除走二次确认弹窗
- **6 个内置 Provider 适配器**（端点全部对齐 [OpenChamber](https://github.com/openchamber/openchamber) 源码实现）
  - `zai`（z.ai Coding Plan 国际站 / 智谱海外）
  - `zhipu`（智谱 bigmodel.cn 国内站）
  - `minimax-io` / `minimax-cn`（MiniMax 编程计划，字段语义国际/国内站不同）
  - `kimi`（Kimi for Coding / Moonshot）
  - `openrouter`
  - `opencode-go`
  - `command-code`
  - 共 11 个 Provider（含 generic / anthropic / openai）
- **OpenCode 凭证发现 + 一键导入**
  - 主进程读 `~/.local/share/opencode/auth.json`（OpenChamber 同款做法）
  - 新增订阅时对话框「从 OpenCode 导入」列表显示已登录的 Provider（掩码）
  - 点选即写入；**明文凭证由主进程自读，不经过 IPC/HTTP 往返**
- **MCP 工具新增 3 个**
  - `pws_list_subscriptions` / `pws_refresh_subscription` / `pws_list_subscription_providers`
- **HTTP API 新增 7 条**：`/api/subscription/{list,get,create,update,delete,refresh,discover,providers}`
- **IPC 通道新增 7 个**：`subscription:{list,get,create,update,delete,refresh,providers,discover}`

### 改进

- **订阅数据层**（`src/main/plugins/builtin/token-usage/subscriptions.ts`）
  - 新表 `provider_subscription`：每行一个订阅，含凭证、配置、最新快照、错误
  - `SubscriptionRefresher`：主进程后台 5 分钟轮询，并发 `Promise.all` 拉取
  - 启动首次延迟 3s（错开 UsageScanner 启动峰）
  - 失败写 `last_error`，下次 tick 再来；`running` flag 防重入
- **QuotaSnapshot 扩展为多窗口模型**（`providers/types.ts`）
  - 新增 `windows: QuotaWindow[]` 数组
  - 单窗模型（generic）继续用 `used/limit/usedPct`
  - 卡片主进度取最紧急窗口
- **订阅卡片 UI 细节**
  - 「刷新/编辑/删除」按钮同时有图标和文字标签
  - 卡片在窄宽度下按钮自动换到下一行；标题副标签省略号截断
- **HTTP / IPC 错误处理**：所有 401/403/超时/解析失败 → 卡片变 error 态 + 短消息显示

### 已知问题 / 设计决定

- **凭证 v1 暂未加密**，存本机 SQLite 明文；编辑对话框不回显
  - v1 暂不接 `electron.safeStorage`（后续可以一行切换）
- **Provider 端点按 OpenChamber 源码对齐**：若服务商响应 schema 变化，对应 adapter
  把 raw 写进 `snapshot.extra`，UI 显示「无法解析（原始响应已捕获）」
- **OpenChamber 是观测平台** vs 本地总台是**控制台**：本工具用同样端点但调度在本地、不上传数据

---

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
