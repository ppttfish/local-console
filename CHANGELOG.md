# Changelog

## v0.4.5 (2026-09-01) — 极致性能

### 性能

- **主线程零阻塞**：`wmic/tasklist` 全异步+5s 缓存后台刷新，`log tail` 全异步+`setImmediate`切片，`scanner` 全链路异步化+`yieldToLoop`每 2000 行/8 文件让出，`fs.watch` 2s 防抖替代 30s 轮询（闲时 5 分钟兜底）
- **大文件零大串**：`>2MB` 流式 `createReadStream+readline`，`streamFileStats/streamFingerprintUpTo/parseLargeFileStreamed` 三段式，Codex/DSH 解压与解析搬入 `parse-worker` 线程，主线程 50MB+ 峰值由 50MB 字符串降为逐行缓冲；全量 `readFile` 改阈值 0，全文件流式
- **DB 零阻塞**：`better-sqlite3` 增 `cache_size=-64000/mmap 256M`，复合索引 `agent_model_at/at_cost`，`summary/timeline/sessions/legacy` 1.5~30s LRU + 写后失效，`querySummaryAsync/timelineAsync/listSessionsAsync` 切片+ `db-worker` 只读连接（WAL 并发），`insert/replace` 500 行/事务分片异步
- **服务/端口**：`services` 1s 内存缓存，`snapshotState→toState` 端口 `find` 改 `Map`（100×50 由 5000 次降 150 次），`port-scanner` `powershell→wmic` 优先（300ms）+自适应退避 5→10→30s，`appendLog` `Buffer.length` 避二次编码+16ms 微批次聚合
- **启动/渲染**：`initDatabase` 后 `log/port/service` 并行，`plugin/updater/http/mcp` 延后至窗口显后/30s，`Usage` 图表 `requestIdleCallback` 空闲计算，`Logs` `content-visibility:auto`，`http` 静态资源 `statCache 5s`+`ETag/304`，`pricing:priceFor` 记忆化（40 万次→数百次），`detectProject` 全异步

### 验证

- `typecheck` 0 error / `lint` 0 error (10 warning 历史遗留) / `build` 三端成功
- Worker 双线程 `parse-worker`/`db-worker` 回包正确（`cost_usd`/`session_id` 校验）

## Unreleased — 日志中心：切换卡顿与空白修复

### 修复

- **日志中心切换后日志空白/串台**：旧实现用单一全局行数组承载日志，切走再切回时若命中主进程的 mtime/size 缓存（`unchanged`）就直接跳过刷新，于是看到的是上一个服务的残留内容或一片空白（切过空日志服务的服务必现）。改为**按服务缓存日志窗口**，切换瞬间先从缓存恢复显示、再后台刷新；缓存缺失或行数切换时用 `force` 强制读盘，不再被其它调用方（CLI/MCP）预热过的缓存吞掉首次内容
- **日志中心切换卡顿**：旧实现任何一次非 `unchanged` 响应都整体替换行数组，1000 行窗口下每次滑动都要重写全部文本节点；快速连点还会并发触发多次 IPC 读盘。现在同一 (服务, 行数) 的请求在途时直接复用（不再并发读盘）、只有真正发出请求的那次占请求序号（复用等待者沿用同一次响应，杜绝「响应被自己占的新号丢弃」导致界面停在旧窗口）；纯追加的轮询由 `mergeLogWindow` 只产出新增行，keyed diff 只插入新节点
- **行数切换不生效**：行数 100→300→1000 切换时主进程缓存会直接返回 `unchanged`，旧版经常切了没反应；现在行数变化即强制重读
- **「最近 N 行」少一行**：主进程 `readTailLines` 把文件结尾 `\n` 产生的空元素也算进窗口，`slice(-want)` 后最新一行被顶掉、空白行占位（界面显示 300 行实际只有 299 行内容）。读取时先剔除结尾空元素，`Logs.vue` 侧同样归一化，顺带状态行行数变为真实日志行数
- **row 增量合并插空白行**：纯追加轮询时新旧窗口的结尾空行错位，会在新旧内容之间插入一行空白；已由上述归一化一并修复
- **Web 模式（standalone HTTP）无法使用**：`/api/app/info` 在无 Electron 上下文时调用 `app.getName()` 崩溃，页面 bootstrap 直接 500。改为独立运行时捕获的 userData 兜底（名称/版本回退「小福鱼」/0.0.0）
- **后台轮询浪费**：页面切到后台（窗口最小化/隐藏）时暂停 2s 轮询，回前台恢复

### 验证

- `npm run typecheck` / `npm run lint`（0 errors）/ `npm run build` 通过
- e2e（playwright + standalone HTTP + 3 个真实服务日志文件，8 次全绿）：切到空日志再切回不空白不串台；快速连点停在正确内容；文件未变化时两个轮询周期 DOM 子节点 0 变更；纯追加只新增 3 个节点；滑动窗口整体正确；1000↔100 行切换立即生效
- `mergeLogWindow` 纯函数单测 6 组全过（幽灵行、纯追加、连续追加、窗口滑动、tail 裁剪、空文本）

## v0.4.3 (2026-08-31) — 订阅全息卡片：文字模糊、点击失效、头像尺寸修复

### 修复

- **订阅监控全息卡片文字发糊**：内容层 `translateZ(26px)` 叠在卡片 `perspective(900px)` 上产生约 1.03× 非整数缩放，任何 DPI 下文字都不是 1:1 渲染。改为内容层**反向旋转补偿**（旋转列表与卡片严格互逆 + 同款过渡），文字始终平行屏幕、1:1 渲染；同时移除悬停 `scale(1.014)`（改由光晕/描边强化）。虹彩箔、光晕、3D 倾斜动效全部保留
- **全息卡片编辑/删除点击失效**（Windows 125%/150% 缩放下按钮可见但点击无反应）：3D 变换在非整数 deviceScaleFactor 下 Chromium 命中测试与绘制位置错位。与上一条同根源，修复后实测恢复正常
- **Provider 头像样式异常**：`.holo-avatar` 误用非标准属性 `size: 38px`（浏览器忽略，头像塌缩成内容宽窄条），改为标准 `width/height`，头像为 38×38 正方形、圆角 8px；同文件状态圆点（6×6）与进度条高亮头（7×7）一并修正

### 验证

- `npm run typecheck` / `npm run build` 通过
- A/B 实测（Electron 31 + DPR 1.5 模拟 150% 缩放）：旧版编辑/删除按钮 hit-test 落在内容区、弹窗不开；修复版命中按钮、编辑/删除弹窗均正常打开
- 计算样式取证：静止态内容层为单位矩阵、内容与卡片 1:1；倾斜态内容层矩阵为卡片旋转矩阵的精确转置（互逆），全程无缩放

## v0.4.2 (2026-08-31) — dsh 统计修复、订阅全息卡片、多实例与并发安全

### 修复

- **dsh 子代理会话重复统计**：dsh 子代理（`origin: subagent`）会把父会话 seed 历史原样复制进自己的 session 文件，同一 usage 事件（seq+time 相同）出现在两个文件里被统计两遍；dsh 扫描改为跨文件按 `seq@time` 去重，实测消除约 700 万 token 虚高
- **dsh input 口径修正**：dsh 的 `totalTokens = inputTokens + outputTokens + cacheReadTokens`，即 `inputTokens` 本身为 fresh（不含缓存命中），不再误扣 `cacheRead`——此前大上下文会话（cacheRead > input）的 input 被扣成 0，fresh 少算、缓存命中率虚高（97.3% → 真实 95.4%）
- **多进程并发重建防翻倍**：Electron 主进程与 MCP standalone 共享 state.db，`replaceUsageBySourceFile` / `replaceUsageByAgent` 把「删旧 + 插新」包进同一写事务（SQLite 写锁串行化），DB 连接加 `busy_timeout`，杜绝并发扫描交错导致用量翻倍
- **HTTP 端口占用容错**：监听失败只记日志，不再把整个主进程拖崩

### 新增

- **订阅监控全息卡片（SubscriptionHoloCard.vue）**：虹彩箔 + 指针光晕 + 3D 倾斜的视觉重构，业务口径（quotaTone / primaryWindow / primaryPct）不变
- **HTTP 端口可配置**：`LCP_PORT` / `PORT` 环境变量覆盖默认 9600，便于多实例共存；托盘「打开 Web 端」同步跟随
- **rescan 异步化**：`/api/usage/rescan` 立即返回 `{ started }`，全量重建在后台扫描队列执行，前端轮询 `status.scanning` / `last_scan_at` 判断完成，请求不再卡 20-25s

### 验证

- `npm run typecheck` 通过；dsh 修复用真实会话数据核对（191 行 → 113 行，总量 1963 万 → 1288 万）

## v0.4.1 (2026-08-28) — Token 口径对齐社区实现（准确性修复）

### 修复

- **Token 统计口径全面对齐社区开源实现（codeburn / better-ccusage / skiplevel / ccusage）**
  - **ZCode（`~/.zcode/cli/db/db.sqlite` 的 `model_usage`）**：`input_tokens` 为全量 prompt（含缓存命中/写入，OpenAI 风格），改为 `fresh = input - cache_read - cache_creation` 后再按 `input` 价计费，`cache_creation` / `cache_read` 单独按缓存价计费；遗漏的 `reasoning_tokens` 计入 `output`，时间戳优先 `completed_at`；校验口径与 codeburn `zcode.ts: fresh = input - cached - created` 完全一致，实测案例 100 = 36 fresh + 64 cached 不再被重复按原价计费（成本虚高 30-90% 已修复）
  - **Codex（`~/.codex/sessions/**/rollout-*.jsonl`）**：`cached_input_tokens` / `cache_write_input_tokens` 均为 `input_tokens` 子集，按 `fresh = input - cached - cache_write` 计费；新增整文件有状态解析 `parseCodexSession`——模型以 `turn_context.model` 为权威（兜底 `info.model` / `model_context_window`），`last_token_usage` 优先、缺失时按 `total_token_usage` 增量差值并处理累计回退/分叉重放；`reasoning_output_tokens` 已含于 `output` 不重复加；口径与 skiplevel `schema-notes-codex.md` / codeburn `codex.ts` 一致
  - **Claude Code（`~/.claude/projects/**/*.jsonl`）**：`cache_creation` 拆 5m / 1h 双桶——`ephemeral_5m_input_tokens` 按 1.25×、`ephemeral_1h_input_tokens` 按 2× 计费（ccusage#899，1h 占多数时旧单价低估约 60%）；定价表新增 `cache_write_1h`（Opus 30 / Sonnet 6 / Haiku 1.6），`calcCost` 支持双桶
  - **OpenCode（`~/.local/share/opencode/opencode.db`）**：`tokens.reasoning` 计入 `output`，`cost` 曾漏算 `cache.read` 导致成本低 2-3 倍（issue #28494），改为优先按定价重算、仅定价缺失时回退到库内 `cost`；存储由 `fresh+cache` 归一化改为 `fresh` 统一存储，避免与 ZCode/Codex 的 inclusive 口径混淆
  - **OMP（`~/.omp/agent/sessions/**/*.jsonl`）**：同 Opencode 改为 `fresh` 存储，成本分桶保持一致
  - **DSH（`~/.dsh/sessions/**/session.jsonl.zstd`）**：`inputTokens` 同为全量，改为 `fresh = input - cacheRead`
  - **聚合层（`storage.ts`）**：所有源统一为 `fresh` 存储后，`total_tokens / by_agent / by_model / by_day / timeline / recap` 的 `SUM` 统一为 `input + cached + output`（与 ccusage `totalTokens = input+cacheCreate+cacheRead+output` 一致），`cache_hit_ratio = cached / (fresh+cached)` 不再双计缓存
- **性能与正确性**：`readZcodeDb` 补 `reasoning_tokens` / `completed_at` 字段；`readOpenCodeDb` 去双 `LIKE '%...%'` 全表扫（已改为 `time_created >= ?` + 索引）；ZCode 扫描保留 `model_usage` 为唯一权威源（rollout 文件仅作兜底，扫描后被 DB 全删全写覆盖，杜绝重复）
- **定价表**：新增 `GLM-5.2` / `GLM-5.1` / `glm-5p1` 别名（codeburn `BUILTIN_ALIASES`），Claude 全系补 `cache_write_1h`；`priceFor` 模糊匹配保留，缺失模型回退 0

### 验证

- `npm run typecheck` / `npm run lint`（0 errors）通过；与 codeburn 提供的 ZCode 真实用例（36 fresh + 64 cached）及 Claude 5m/1h 示例对齐，ZCode 成本不再虚高，Claude 1h 缓存成本已按 2× 结算

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
