# Changelog

## v0.4.0 (2026-08-28) — 薅羊毛页

### 新增

- **侧边栏新增「薅羊毛」页**：收录近期免费额度 / 体验卡等活动信息
  - 卡片瀑布流布局（窄屏一列 → 宽屏三列），高度不齐自动补位
  - 进行中的活动置顶；过期的自动沉底并整卡去色置灰，带「已过期」标识与截止日期
  - API 地址与模型名一键复制，活动链接经系统浏览器打开（Electron / Web 两种模式均可用）
- **活动数据免发版更新**：单一数据源为仓库 `src/renderer/src/data/deals.json`，应用运行时经 jsDelivr / GitHub raw 远程拉取——改 JSON 推送即对全部用户生效，无需发新版本；本地 localStorage 缓存 + 打包内置双兜底，断网也有内容可看
- 首发收录两条：GLM Coding Plan 7 天体验卡（一周内每天限量 10,000 张）、MiniMax × GMI Cloud 免费试用 14 天（8/24 – 9/6）

## v0.3.1 (2026-08-28) — 卡顿根治与渲染层稳定性修复

### 修复

- **根治切换路由/Tab 时的整机卡顿**：端口扫描器的进程信息富化由逐 PID 发 WMI 查询（10 个 PID 即需 4s+，几十个监听端口时一轮数十秒，且 2s 轮询无防重入导致多轮 PowerShell 并发堆叠吃满 CPU）改为——
  - 单次批量枚举（约 1.5s，耗时与 PID 数基本无关）
  - 补上防重入，同一时刻最多一轮扫描在跑
  - 监听端口集合未变化时直接复用缓存，稳态下零 PowerShell 开销
- **日志中心不再拖慢界面**：日志流逐行动画组件（选「最近 1000 行」时最多 1000 个 Motion 实例常驻动画引擎，每 2s 全量 patch）改为纯 div 渲染 + CSS 动画，仅最后 3 行播入场动效
- **日志/用量页请求竞态**：快速切换服务/筛选/行数时，慢响应不再把旧数据覆盖到新筛选条件下（请求序号防回写）
- **用量页「模型」下拉 console 报错**：`SelectItem` 空 value 触发 reka-ui 报错，「全部模型」改用 `all` 哨兵值
- **系统主题跟随监听从未生效**：原先注册在组件外调用的 `onMounted` 里（无组件实例即静默丢失），改模块级注册一次
- 日志页打开时服务列表异步就位后自动选中第一个，不再需要手动点
- 清理用量页无效的 chartRefs 收集逻辑（`@vue:mounted` 收到的是 VNode 而非 Chart 实例，主题换色实际由 options 响应链路驱动）

## v0.3.0 (2026-08-28) — 回顾 Tab（Wrapped）+ 视觉根因修复

### 新增

- **用量页新增「回顾」Tab**（支持 `#/usage?tab=recap` 深链）
  - Hero 四卡：累计 Token / 累计成本 / 活跃天数（当前连续 + 最长连续）/ 高峰日
  - **本命模型**：用量占比环形图 + tokens / 调用 / 缓存命中三联数据
  - **作息分布**：24 小时调用柱状图，最活跃时段高亮，附作息人格一句话
  - **成就徽章墙 10 枚**：初见之日 / 百万俱乐部 / 千万战队 / 氪金玩家 / 本命不渝 / 缓存大师 / 七日之约 / 全天候战士 / 夜行侠 / 多栖动物；未达成显示进度条
  - **近 12 周热力图**：按天 token 着色，悬停看每日明细
- **回顾数据三出口**：MCP `pws_usage_recap` / HTTP `GET /api/usage/recap` / IPC `usage:recap`，全部来自 `queryRecap()` 全时段聚合，类型契约收口 `shared/types` 的 `UsageRecap`
- 格式化函数抽取 `lib/format.ts`，成就规则独立 `lib/achievements.ts`

### 修复

- **移除遗留 index.css，根治新旧设计令牌冲突**：旧 `--muted` / `--accent` 后置加载覆盖新 shadcn 令牌，导致 Tab 栏通栏深条、服务卡命令条深灰不可读、侧边栏选中态刺眼蓝
- **路由与 Tab 切换瞬时化**：移除 `AnimatePresence mode="wait"` 路由动画包裹（query 变化曾触发整页重挂动画，切换也被弹簧过渡拖慢）
- 页面间距统一 16px 节奏（Tabs 根 gap 与 TabsContent mt 叠加不一致）
- 侧边栏品牌 logo 换回 🐟 小福鱼
- 服务停止态不再渲染零值 sparkline（原似分割线的脏块）
- 趋势图成本为 $0 时不再画对称噪音轴与虚线

## v0.2.5 (2026-08-27) — 安装版数据目录统一

### 修复

- **安装版打开后服务与用量数据全空**：Electron 打包版 userData 由 `%APPDATA%\本地总台` 统一为 `%LOCALAPPDATA%\local-console`，与网页端 / CLI 入口一致；已产生的全部历史数据（服务配置、token 用量、订阅监控）自动回归，无需迁移

## v0.2.4 (2026-08-27) — 用量统计 DSH 接入 + 平台口径修正 + Mac 支持

### 新增

- **用量统计接入 DSH（DeepSeek Harness）**
  - 扫描 `~/.dsh/sessions/**/session-*/session.jsonl.zstd`（zstd 压缩会话，fzstd 纯 JS 解压，不引入原生依赖）
  - usage 取自 `assistant/chunk` 行（inputTokens/outputTokens/cacheReadTokens），模型名跟随 `request/context`
  - zstd 流无法按行增量：以全目录文件指纹（size+mtime）变化触发整库重建
  - 平台筛选条新增 DSH 入口；状态栏显示已扫描会话数
- **平台卡片「用量排行」Tab**：默认视图改为按 Token 横条排行（名次/平台色占比条/Token/成本），可切回原「成本占比」环图
- **Mac 安装包**：新增 dmg + zip（x64 / arm64 双架构，未签名——首启需右键打开放行）；发布流程升级为 Windows/macOS 双 CI，推 tag 自动出双平台产物
- **服务卡片一键访问**：端口条目支持直接在系统浏览器打开对应 web 应用（openUrl 仅限本机 http/https）
- 应用图标更新

### 修复

- **平台口径纠偏**：`~/.local/share/opencode/opencode.db` 的实际写入者按本机特征自动探测（存在 OpenChamber 配置目录则显示「OpenChamber」，否则「OpenCode」），其他机器各自准确；OMP 不再误标为 "OMP (OpenChamber)"——它是与 OpenChamber 无关的独立客户端
- **重新扫描双计 bug**：rescan 先清空用量表再全量重建（旧逻辑重置游标后纯 INSERT 叠加，会把 jsonl 类数据翻倍）；历史点过「重新扫描」造成的翻倍数据、以及 Claude 历史缓存字段全 0 的脏数据，升级后点一次「重新扫描」即自动修复

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
