# 本地总台（local-console）

一站式管理本机的开发服务、批处理任务、agent token 用量。

桌面端是 **Electron 桌面应用**，同时提供 `http://127.0.0.1:9600` 的 web 镜像——浏览器和桌面窗口**共享同一份数据**。

---

## 功能概览

| 模块 | 状态 | 说明 |
|---|---|---|
| **启动台** | ✅ | 长期服务 / 批处理任务的增删改查、启停、重启、复制命令 |
| **服务监控** | ✅ | 每 2 秒扫描本机 LISTEN 端口，标记已纳管 / 外部进程 |
| **Token 用量** | ✅ | 5 个 agent 的 token / 成本 / 缓存命中率，**多维筛选**（平台/模型/日期/粒度）+ Chart.js 图表 |
| **日志中心** | ✅ | 每个服务独立日志文件，自动轮转 2MB |
| **MCP server** | ✅ | stdio JSON-RPC，11 个工具，被 Claude / Codex / Cursor 等任意 MCP 客户端调用 |
| **CLI `lcp`** | ✅ | 命令行也能用（list / start / stop / restart / logs / ports / add） |
| **HTTP server** | ✅ | 同一个 9600，浏览器 + API（`/api/state`, `/api/usage/summary` 等） |
| **托盘 / 单实例 / 开机自启** | ✅ | 关窗 = 隐藏到托盘，进程常驻 |
| **主题切换** | ✅ | 亮 / 暗 / 跟随系统 |

---

## 快速开始

### 开发模式（热重载）

```bash
cd local-console
npm install
npm run dev
```

启动 Electron 窗口 + 9600 web。

### 跑桌面端

```bash
# 1. 编译
npm run build

# 2. 打绿色版（跳过 nsis 安装包，避开 winCodeSign 符号链接 bug）
npx electron-builder --dir --win --x64

# 3. 复制 electron runtime + icon + renderer（因为 winCodeSign 失败没拷）
cp node_modules/electron/dist/electron.exe dist/win-unpacked/local-console.exe
cp build/icon.ico dist/win-unpacked/resources/icon.ico
cp -r out/renderer dist/win-unpacked/resources/renderer

# 4. 双击运行
dist/win-unpacked/local-console.exe
```

或者直接双击 `dist/win-unpacked/local-console.exe`（已就绪的情况下）。

### 跑 9600 web（无 GUI）

```bash
# 编译后
F:/local-console/node_modules/electron/dist/electron.exe \
  out/main/http-standalone.js
# 浏览器访问 http://127.0.0.1:9600
```

### 跑 MCP server（给 agent 用）

```bash
# Claude Desktop / Cursor / Codex MCP 配置:
{
  "mcpServers": {
    "local-console": {
      "command": "F:/local-console/node_modules/electron/dist/electron.exe",
      "args": ["F:/local-console/out/main/mcp/standalone.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

8 个服务管理工具 + 3 个 token 用量工具。

---

## 架构

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # GUI 入口（窗口/托盘/单实例）
│   ├── http-server.ts             # 9600 HTTP 服务
│   ├── http-standalone.ts         # 无 GUI 启动 9600 的入口
│   ├── mcp/standalone.ts          # MCP server
│   ├── services/                  # 业务核心
│   │   ├── db.ts                  # SQLite 封装
│   │   ├── service-manager.ts     # 进程启动/停止
│   │   ├── port-scanner.ts        # netstat + WMI
│   │   ├── log-streamer.ts        # 日志读写
│   │   └── event-bus.ts           # 进程内事件
│   ├── plugins/builtin/token-usage/  # 第一个插件
│   │   ├── index.ts               # 插件入口
│   │   ├── source-registry.ts     # agent 路径表
│   │   ├── scanner.ts             # 增量扫描
│   │   ├── parsers.ts             # 5 个 JSONL 解析器 + SQLite
│   │   ├── pricing.ts             # 模型定价表
│   │   └── storage.ts             # SQLite 表 + 查询
│   ├── ipc/index.ts               # IPC handlers
│   └── utils/proc-tree.ts         # Windows Job Object
├── preload/index.ts               # contextBridge.exposeInMainWorld
├── renderer/src/                  # Vue 3 + Pinia
│   ├── pages/                     # 5 个页面
│   │   ├── Launchpad.vue
│   │   ├── Monitor.vue
│   │   ├── Usage.vue              # KPI + Chart.js 折线/饼图
│   │   ├── Logs.vue
│   │   └── Settings.vue
│   ├── components/                 # Sidebar, ServiceCard, AddServiceDialog
│   ├── composables/useTheme.ts     # 主题切换
│   ├── stores/app.ts               # Pinia store
│   ├── web-bridge.ts               # 浏览器模式 fetch 桥（preload 不存在时接管）
│   └── styles/index.css           # 主题变量 + 全局组件样式
├── shared/                        # 跨进程类型契约
│   ├── types.ts
│   └── ipc-channels.ts
└── cli/lcp.ts                     # 命令行客户端
```

---

## 数据布局

**GUI 模式**（`local-console.exe` 跑）：

```
%APPDATA%\Local Console\
├── state.db                      # SQLite: services / run_history / agent_usage / ...
├── startup.log                   # 主进程启动日志（排查用）
└── logs/                          # 服务日志
```

**web 9600 / MCP standalone**（无 GUI）：

```
%LOCALAPPDATA%\local-console\state.db
```

> ⚠️ **两个数据库路径不同**，数据不互通。v1.1 计划统一。

**`agent_usage` 表**（核心 token 数据）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `agent` | text | `omp` / `zcode` / `opencode` / `codex` / `claude` |
| `model` | text | `MiniMaxAI/MiniMax-M3` / `GLM-5.3` / ... |
| `input_tokens` | int | 非缓存输入 |
| `output_tokens` | int | 输出 |
| `cached_tokens` | int | `cache_read + cache_write` |
| `cache_read_tokens` | int | 缓存读 |
| `cache_write_tokens` | int | 缓存写（Anthropic 计费按写入） |
| `cost_usd` | real | 美元成本（按 `pricing.ts` 算） |
| `at` | int | 毫秒时间戳 |
| `session_id` | text | 会话 id |
| `meta` | text | JSON 扩展 |

**时区固定 +8h**（SQLite strftime 不带时区）—— 跨时区用户在 `storage.ts` 改 `'+8 hours'`。

---

## 怎么加新 agent

只改两个文件：

**1. `src/main/plugins/builtin/token-usage/source-registry.ts`** — 加一行：

```ts
{
  agent: 'your-agent',
  displayName: 'Your Agent',
  description: '...',
  type: 'jsonl',
  homeSubpath: '.your-agent',
  pathGlob: 'sessions/**/*.jsonl',
  filePattern: /\.jsonl$/,
  parser: 'your-agent'
}
```

**2. `src/main/plugins/builtin/token-usage/parsers.ts`** — 加 `parseYourAgentLine` + 把 `agent: Platform` 加 `'your-agent'`：

```ts
export type Platform =
  | 'omp' | 'zcode' | 'opencode' | 'codex' | 'claude'
  | 'your-agent'  // ← 新增

function parseYourAgentLine(line: string, ctx: ParseContext): UsageRow | null {
  // 解析你的 JSONL
}
```

**3. 重启** —— scanner 自动遍历新 source，识别新目录，**未识别 agent 目录**会写到 `startup.log` 提醒。

> 💡 不知道是不是 agent？看 `startup.log` 里有 "未识别渠道" 列表，常见候选（`~/.deepseek-harness`、`~/.kilocode` 等）已内置探测。

---

## MCP 工具（11 个）

| 工具 | 说明 |
|---|---|
| `pws_list_services` | 列出所有服务及状态 |
| `pws_start_service` / `pws_stop_service` / `pws_restart_service` | 启停 / 重启（按 id 或 name） |
| `pws_service_logs` | 读服务日志 |
| `pws_scan_ports` | 扫描本机所有 LISTEN 端口 |
| `pws_add_service` | 新增服务到启动台 |
| `pws_delete_service` | 删除服务 |
| `pws_query_agent_usage` | 多维聚合（agent/model/from/to/granularity） |
| `pws_list_agents` | 列出已发现 agent 平台与模型 |
| `pws_rescan_agents` | 手动全量重扫 |
| `pws_get_pricing` | 获取所有模型 USD 定价 |

---

## UI 截图

- **启动台** —— 服务卡片 + 一键启停
- **服务监控** —— 端口 TOP 50，已纳管 / 外部进程标记
- **Token 用量** —— 4 KPI + 折线图（双 Y 轴 token + 成本）+ 甜甜圈（按平台）+ 条形图（按模型 TOP 10）
- **日志中心** —— 服务日志实时查看 + 100/300/1000 行切换 + 自动滚到底
- **设置** —— 主题切换 ☀ 🌙 ⚙

---

## 已知限制

| 项 | 原因 / 何时修 |
|---|---|
| **数据库双路径** | GUI 模式 vs web 模式 userData 不同 → v1.1 统一 |
| **打包 `nsis` 失败** | electron-builder 24 的 winCodeSign 缓存含 macOS 符号链接，7-Zip 在 Windows 无法创建 → 用绿色版替代 |
| **手动拷贝文件** | winCodeSign 失败导致 `electron-builder --dir` 后 exe / icon / renderer 三个文件不会自动拷出来——文档里列了手动 cp 三行 |
| **Codex 模型名是假名** | 取自 `model_context_window` 字段（`codex-353400k`），不是真模型名 → v1.1 改 |
| **时区硬编码 +8h** | SQLite strftime 不带时区，SQL 里写死 `'+8 hours'` |
| **OMP 缓存读写合并** | Anthropic 计费里 `cache_creation` 是写入不是命中，v1 合并统计 → v1.1 拆分 |
| **OpenCode 去重用全删全写** | db 没稳定 request_id，简化 |
| **首次启动窗口可能最小化** | Windows 11 + `start /B` 行为 → 在 main.ts 加 `Minimized: false` 显式选项 |
---

## 自动升级

走 **GitHub Releases + electron-updater**。`v0.2.1` 起内置。

### 发版流程

```bash
# 1. 改 package.json version（如 0.2.1 → 0.3.0），提交
git add -A && git commit -m "release: 0.3.0"

# 2. 打 tag + 推
git tag v0.3.0 && git push origin main v0.3.0
```

GitHub Actions 自动跑 `.github/workflows/release.yml`：
- windows-latest runner
- `npm ci` → `npm run build` → `electron-builder --win portable --x64`
- 产物 `本地总台-0.3.0-Portable.exe` + `latest.yml` + `*.blockmap`
- 自动创建 / 更新 GitHub Release

### 升级体验

- **被动**：本地 GUI 启动 30s 后 + 每小时一次后台检查 GitHub latest.yml
- **主动**：托盘菜单「检查更新」或设置页「检查更新」按钮
- **发现新版本**：主进程弹独立窗口，显示「当前 → 新」+ release notes
- **下载**：进度条 + 速度
- **安装**：点「立即重启并升级」→ `quitAndInstall()` → 重启新版本
- **跳过**：点「稍后」只关弹窗，下次启动继续后台检查

### 已知限制

- portable 走 `quitAndInstall` 重启新版本，**第一次需要手动从 GitHub Releases 下载 portable.exe 安装**（之后所有更新都自动）



---

## 开发命令

```bash
npm run dev            # 启动 dev server（热重载）
npm run build          # 编译 out/
npm run typecheck      # ts 主进程 + web 端类型检查
npm run package:dir    # 打绿色版 unpacked
npm run start          # 跑编译后的 GUI
npm run start:web      # 跑编译后的 9600 web（无 GUI）
npm run mcp            # 跑编译后的 MCP server
```

### 冒烟脚本

```bash
node scripts/mcp-smoke.mjs        # 11 工具 + 启动 / 停止
node scripts/mcp-v2-smoke.mjs     # token-usage 5 agent 数据
node scripts/mcp-usage-smoke.mjs  # 3 个 usage 工具
node scripts/db-check.mjs         # 直查 SQLite（绕过 ABI 兼容问题）
node scripts/cdp-eval.mjs        # CDP 调试 GUI 渲染端（带 remote-debugging-port=9222）
```

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Electron 31 + Vue 3.5 + Pinia 2 + Vue Router 4 |
| 构建 | electron-vite 2 + Vite 5 + TypeScript 5.5 |
| 桌面打包 | electron-builder 24（**有 winCodeSign bug，见上**） |
| 数据库 | better-sqlite 11（WAL 模式） |
| 图表 | Chart.js 4.4 + vue-chartjs 5.3 |
| MCP | @modelcontextprotocol/sdk 1.0 |
| 进程树 | node:child_process.spawn + Windows taskkill /T |

---

## 许可

MIT
