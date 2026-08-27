# Token 用量统计插件 v2

`token-usage` 是本地总台的内置插件，扫描本机 5 个 agent 的会话日志，把每次模型调用的 token 用量与 **USD 成本** 入库，提供多维聚合查询 + 可视化图表。

## 回顾 Tab（Wrapped）v2.1

Usage 页第三个 Tab（`#/usage?tab=recap` 可深链），全时段叙事视图：

- **数据出口**：IPC `usage:recap` / HTTP `GET /api/usage/recap` / MCP `pws_usage_recap`，全部来自 `storage.ts` 的 `queryRecap()`，类型契约在 `@shared/types` 的 `UsageRecap`
- **渲染**：`components/RecapPanel.vue`（Hero 四卡 / 本命模型环形 / 作息分布 / 12 周热力图）
- **成就规则**：`renderer/src/lib/achievements.ts`（10 枚：初见之日 / 百万俱乐部 / 千万战队 / 氪金玩家 / 本命不渝 / 缓存大师 / 七日之约 / 全天候战士 / 夜行侠 / 多栖动物），纯聚合派生，无额外建表
- **格式化**：`renderer/src/lib/format.ts`（fmtToken / fmtCost 等，Usage 页共用）

## 采集的 agent（按本机实际）

| 平台 | 日志位置（Windows） | 解析的字段 | 备注 |
|---|---|---|---|
| **OMP** (OpenChamber) | `%USERPROFILE%/.omp/agent/sessions/**/*.jsonl` | `message.usage.{input,output,cacheRead,cacheWrite,totalTokens,cost}` | 主代理，含 `MiniMax-M3` |
| **ZCode** | `%USERPROFILE%/.zcode/cli/rollout/model-io-sess_*.jsonl` | `response.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` | 含 `GLM-5.3` 等 |
| **OpenCode** | `%USERPROFILE%/.local/share/opencode/opencode.db` | SQL `message.data.tokens.{input,output,cache.{read,write}}` | 走 SQLite readonly；含 `mimo-v2-pro-free` |
| **Codex** | `%USERPROFILE%/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `event_msg.payload.type=token_count.last_token_usage.{input_tokens,cached_input_tokens,output_tokens}` | 8 月深度 `~/.codex/sessions/2026/` |
| **Claude Code** | `%USERPROFILE%/.claude/projects/**/*.jsonl` | `assistant.message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` | 标准 schema |

## 数据模型（v2）

```sql
CREATE TABLE agent_usage (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,            -- omp / zcode / opencode / codex / claude
  model TEXT NOT NULL,            -- MiniMax-M3 / GLM-5.3 / mimo-v2-pro-free / gpt-5.4 ...
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cache_read_tokens INTEGER,      -- v2 字段
  cache_write_tokens INTEGER,     -- v2 字段（Anthropic 缓存创建计费）
  cost_usd REAL,                  -- v2 字段（按 model-pricing.json 算）
  at INTEGER,
  session_id TEXT,
  meta TEXT
);

CREATE TABLE agent_file_cursor (  -- jsonl 增量游标
  file_path TEXT PRIMARY KEY,
  file_size INTEGER,
  file_mtime INTEGER,
  lines_seen INTEGER
);
-- opencode 单独用 db 文件 mtime 当游标
```

v1 → v2 自动迁移：缺列时 `ALTER TABLE ADD COLUMN`。

## 定价（pricing.ts）

`%APPDATA%/local-console/model-pricing.json` 维护一张 `(model → {input, output, cache_read, cache_write})` 表，**单位 USD/1M tokens**。已内嵌 40+ 主流模型默认价（GPT-4o/5.x、Claude Opus 4/Sonnet 4、Gemini 2.5、Grok 4.5、DeepSeek、GLM、MiniMax 等）。

`calcCost(model, in, out, cr, cw)` 返回 USD。未匹配的模型 → 0 美元（避免脏数据）。

## MCP 工具（4 个）

### `pws_query_agent_usage`

**参数**：
- `agent`: `omp` / `zcode` / `opencode` / `codex` / `claude` / `all`
- `model`: 模型名精确匹配
- `from` / `to`: 毫秒时间戳
- `granularity`: `hour` / `day` / `month`

**返回**：
```json
{
  "summary": {
    "total_tokens": 5.4e7,
    "input_tokens": 4.4e7,
    "output_tokens": 4.0e5,
    "cached_tokens": 1.0e7,
    "cache_read_tokens": 1.0e7,
    "cache_write_tokens": 0,
    "cache_hit_ratio": 18.7,
    "cost_usd": 45.94,
    "calls": 20829,
    "by_agent":  [...],   // 含 cost
    "by_model":  [...],   // 含 cost + cache_read + cache_write
    "by_day":    [...]    // 含 cost
  },
  "timeline": [{ "bucket", "tokens", "input", "output", "cache_read", "cache_write", "cost", "calls" }]
}
```

### `pws_list_agents`
返回 `{ agents, models, stats: { files_scanned, rows_inserted, by_agent, opencode_messages } }`

### `pws_rescan_agents`
重置 cursor 全量重扫。

### `pws_get_pricing`
返回当前所有模型 USD/1M 定价。

## UI 页面

`http://127.0.0.1:9600/#/usage`

**组件**（Chart.js 4.4）：
- 4 KPI 卡片：总 Token / 总成本 / 调用次数 / 缓存命中率
- 折线图：趋势（双 Y 轴，token + USD 成本虚线）
- 甜甜圈图：成本按平台占比
- 水平条形图：模型 TOP 10 的 Token + 缓存读
- 明细表：按平台 / 按模型 / Top 会话

**筛选器**：平台（5 个） / 时间（24h/7d/30d/全部） / 粒度（小时/日月） / 模型下拉。

## 增量扫描策略

| 数据源 | 增量方式 |
|---|---|
| 4 个 jsonl | 文件级 `(file_size, file_mtime, lines_seen)` 三元组 |
| opencode.db | db 文件 mtime |

每 30 秒自动重扫。

## 借鉴 ccswitch 的设计

- `usage_daily_rollups` 表 / `session_log_sync` 游标 → 直接抄思路
- `proxy_request_logs` 字段（first_token_ms、input_cost_usd 等）→ v2 已有 cost_usd；first_token 留 v2.1
- `model-pricing.json` → 内嵌 + 用户可改

## 已知限制

- **时区硬编码 +8h**（SQLite strftime）—— 跨时区用户改 `'+8 hours'`
- **omp 缓存读 0 价**、**MiniMax-M3 0 价**（默认表未填该模型）—— 用户可在 `model-pricing.json` 补
- **Claude 缓存读/写**已合并到 `cache_read_tokens` / `cache_write_tokens`；Anthropic 计费里 cache_creation 是写不是命中
- **Codex 模型名**取自 `model_context_window`（如 `codex-353400k`），不是真实模型名——v2.1 改
- **OMP/ZCode/Codex 增量**：mtime + size 双重判断；若文件被原地覆盖（partial write）可能漏读，v2.1 加 WAL 感知
- **opencode.db** 无稳定 request_id，简化全删全写
