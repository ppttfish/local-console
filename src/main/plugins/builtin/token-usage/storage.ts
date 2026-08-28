/**
 * token-usage 数据层 v2 —— 支持 cost_usd + cache 读/写分桶
 */
import { getDb, prepare } from '../../../services/db.js'
import { calcCost, priceFor, loadPricing, type ModelPrice } from './pricing.js'

export type Platform = 'omp' | 'zcode' | 'opencode' | 'codex' | 'claude' | 'dsh' | 'unknown'

export interface UsageRow {
  agent: Platform
  model: string
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  at: number
  session_id: string
  meta: string | null
  /**
   * 产生这一行的源文件绝对路径。
   * 文件被压缩/重写时它是「全删全写」唯一干净的删除边界 —— session_id 可能被
   * 行内字段覆盖（zcode 的 sessionId），只按 session_id 删会漏行。
   * 升级前写入的老行此列为 NULL，删除时有一层 agent+session_id 兜底。
   */
  source_file: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  session_id TEXT,
  meta TEXT,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON agent_usage(at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON agent_usage(agent);
CREATE INDEX IF NOT EXISTS idx_usage_model ON agent_usage(model);
CREATE INDEX IF NOT EXISTS idx_usage_agent_at ON agent_usage(agent, at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON agent_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_session_at ON agent_usage(session_id, at);
-- 注意：idx_usage_source 不能写在这里。
-- 老库的 agent_usage 还没有 source_file 列，CREATE INDEX 会在迁移 addCol 之前执行
-- 而直接报 "no such column: source_file"，导致整个插件加载失败。
-- 它放在 ensureUsageSchema 的迁移段（addCol 之后）里创建。

CREATE TABLE IF NOT EXISTS agent_file_cursor (
  file_path TEXT PRIMARY KEY,
  file_size INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL,
  lines_seen INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT
);
`

export function ensureUsageSchema(): void {
  const db = getDb()
  db.exec(SCHEMA)
  // 列迁移：v1 旧表缺 cache_read/write_tokens / cost_usd
  const cols = db
    .prepare('PRAGMA table_info(agent_usage)')
    .all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  const addCol = (col: string, def: string) => {
    if (!names.has(col)) db.exec(`ALTER TABLE agent_usage ADD COLUMN ${col} ${def}`)
  }
  addCol('cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0')
  addCol('cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0')
  addCol('cost_usd', 'REAL NOT NULL DEFAULT 0')
  addCol('source_file', 'TEXT')

  const cursorCols = db
    .prepare('PRAGMA table_info(agent_file_cursor)')
    .all() as Array<{ name: string }>
  if (!new Set(cursorCols.map((c) => c.name)).has('head_hash')) {
    db.exec('ALTER TABLE agent_file_cursor ADD COLUMN head_hash TEXT')
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_usage_session_at ON agent_usage(session_id, at)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_usage_source ON agent_usage(source_file)'
  )
}

export function insertUsageBatch(rows: UsageRow[]): number {
  if (rows.length === 0) return 0
  const stmt = prepare(
    `INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens, cost_usd, at, session_id, meta, source_file)
     VALUES (@agent, @model, @input_tokens, @output_tokens, @cached_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd, @at, @session_id, @meta, @source_file)`
  )
  const tx = getDb().transaction((items: UsageRow[]) => {
    for (const r of items) stmt.run(r)
  })
  tx(rows)
  return rows.length
}

/**
 * 删除某个源文件贡献过的全部用量行。
 * 文件被重写（压缩 / 重排 / 截断）后必须整文件重建，重建前不清干净就会叠加翻倍。
 * 老数据的 source_file 为 NULL，用 agent + session_id 兜底回收。
 */
export function deleteUsageBySourceFile(
  filePath: string,
  agent: Platform,
  sessionId: string
): number {
  const r = prepare(
      `DELETE FROM agent_usage
       WHERE source_file = @file
          OR (source_file IS NULL AND agent = @agent AND session_id = @sessionId)`
    )
    .run({ file: filePath, agent, sessionId })
  return r.changes
}

/** 某个 agent 当前最早一条的时间戳；没有数据返回 0（表示从头扫） */
export function minAtForAgent(agent: Platform): number {
  const r = prepare('SELECT MIN(at) AS m FROM agent_usage WHERE agent = ?')
    .get(agent) as { m: number | null }
  return r.m ?? 0
}

/**
 * source_file 为空的历史行数：> 0 说明还有只能靠 agent+session_id 兜底回收的老数据。
 * 只判 IS NULL —— 再并一个 `OR source_file = ''` 会让这条每 30 秒跑一次的统计退化成全表扫。
 */
export function countLegacyRows(): number {
  const r = prepare(
      'SELECT COUNT(*) AS n FROM agent_usage WHERE source_file IS NULL'
    )
    .get() as { n: number }
  return r.n ?? 0
}

// ========== Cursor ==========
interface CursorRow {
  file_path: string
  file_size: number
  file_mtime: number
  lines_seen: number
  /** 已入库前缀的指纹；NULL 表示老游标，尚未纳入重写检测 */
  head_hash: string | null
}

export function getCursor(filePath: string): CursorRow | null {
  const r = prepare('SELECT * FROM agent_file_cursor WHERE file_path = ?')
    .get(filePath) as CursorRow | undefined
  return r ?? null
}

export function upsertCursor(
  filePath: string,
  size: number,
  mtime: number,
  linesSeen: number,
  headHash: string
): void {
  prepare(
      `INSERT INTO agent_file_cursor (file_path, file_size, file_mtime, lines_seen, head_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_size = excluded.file_size,
         file_mtime = excluded.file_mtime,
         lines_seen = excluded.lines_seen,
         head_hash = excluded.head_hash`
    )
    .run(filePath, size, mtime, linesSeen, headHash)
}

export function resetCursor(filePath: string): void {
  prepare('DELETE FROM agent_file_cursor WHERE file_path = ?')
    .run(filePath)
}

export function resetAllCursors(): void {
  prepare('DELETE FROM agent_file_cursor').run()
}

export function dropUsageTable(): void {
  getDb().exec('DROP TABLE IF EXISTS agent_usage')
}

// ========== Filter ==========
export interface UsageFilter {
  agent?: Platform | 'all'
  model?: string
  from?: number
  to?: number
}

interface WhereClause {
  clause: string
  params: Record<string, unknown>
}

function buildWhere(filter: UsageFilter): WhereClause {
  const conds: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.agent && filter.agent !== 'all') {
    conds.push('agent = @agent')
    params.agent = filter.agent
  }
  if (filter.model) {
    conds.push('model = @model')
    params.model = filter.model
  }
  if (typeof filter.from === 'number') {
    conds.push('at >= @from')
    params.from = filter.from
  }
  if (typeof filter.to === 'number') {
    conds.push('at <= @to')
    params.to = filter.to
  }
  return {
    clause: conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '',
    params
  }
}

// ========== 聚合 ==========
export interface UsageSummary {
  /**
   * 总 token 数 = fresh 输入 + 缓存命中 + 输出（与 ccusage totalTokens = input+cacheRead+cacheWrite+output 一致）。
   * 所有源均按 fresh 存储（input_tokens 为非缓存 fresh，已扣减 cached），因此需显式 + cached。
   */
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cache_hit_ratio: number
  cost_usd: number
  calls: number
  by_agent: Array<{ agent: string; tokens: number; calls: number; cost: number }>
  by_model: Array<{
    model: string
    tokens: number
    calls: number
    cost: number
    cache_read: number
    cache_write: number
  }>
  by_day: Array<{ day: string; tokens: number; calls: number; cost: number }>
}

export function querySummary(filter: UsageFilter): UsageSummary {
  const where = buildWhere(filter)
  const totals = prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS inp,
         COALESCE(SUM(output_tokens), 0) AS out,
         COALESCE(SUM(cached_tokens), 0) AS cached,
         COALESCE(SUM(cache_read_tokens), 0) AS cr,
         COALESCE(SUM(cache_write_tokens), 0) AS cw,
         COALESCE(SUM(cost_usd), 0) AS cost,
         COUNT(*) AS calls
       FROM agent_usage ${where.clause}`
    )
    .get(where.params) as {
    inp: number
    out: number
    cached: number
    cr: number
    cw: number
    cost: number
    calls: number
  }

  const byAgent = prepare(
      `SELECT agent,
              SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM agent_usage ${where.clause}
       GROUP BY agent
       ORDER BY cost DESC`
    )
    .all(where.params) as Array<{ agent: string; tokens: number; calls: number; cost: number }>

  const byModel = prepare(
      `SELECT model,
              SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write
       FROM agent_usage ${where.clause}
       GROUP BY model
       ORDER BY cost DESC
       LIMIT 50`
    )
    .all(where.params) as Array<{
    model: string
    tokens: number
    calls: number
    cost: number
    cache_read: number
    cache_write: number
  }>

  const byDay = prepare(
      `SELECT
         strftime('%Y-%m-%d', at/1000, 'unixepoch', '+8 hours') AS day,
         SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
         COUNT(*) AS calls,
         COALESCE(SUM(cost_usd), 0) AS cost
       FROM agent_usage ${where.clause}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(where.params) as Array<{ day: string; tokens: number; calls: number; cost: number }>

  const inp = totals.inp ?? 0
  const cached = totals.cached ?? 0
  const cacheHit =
    inp + cached > 0 ? Math.round((cached / (inp + cached)) * 1000) / 10 : 0

  return {
    // 统一 fresh 存储：total = fresh + cached + output（与 ccusage totalTokens = input+cacheCreate+cacheRead+output 一致）
    total_tokens: inp + (totals.out ?? 0) + cached,
    input_tokens: inp,
    output_tokens: totals.out ?? 0,
    cached_tokens: cached,
    cache_read_tokens: totals.cr ?? 0,
    cache_write_tokens: totals.cw ?? 0,
    cache_hit_ratio: cacheHit,
    cost_usd: totals.cost ?? 0,
    calls: totals.calls ?? 0,
    by_agent: byAgent,
    by_model: byModel,
    by_day: byDay
  }
}

export function listDistinctModels(): string[] {
  return (
    prepare('SELECT DISTINCT model FROM agent_usage ORDER BY model ASC')
      .all() as Array<{ model: string }>
  ).map((r) => r.model)
}

export function listDistinctAgents(): Platform[] {
  return (
    prepare('SELECT DISTINCT agent FROM agent_usage ORDER BY agent ASC')
      .all() as Array<{ agent: Platform }>
  ).map((r) => r.agent)
}

export interface SessionDetail {
  session_id: string
  agent: Platform
  first_at: number
  last_at: number
  calls: number
  tokens: number
  cost: number
  model: string | null
}

export function listSessions(filter: UsageFilter, limit = 200): SessionDetail[] {
  const where = buildWhere(filter)
  return prepare(
      `SELECT
         session_id,
         agent,
         MIN(at) AS first_at,
         MAX(at) AS last_at,
         COUNT(*) AS calls,
         SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
         COALESCE(SUM(cost_usd), 0) AS cost,
         (SELECT model FROM agent_usage u2
            WHERE u2.session_id = agent_usage.session_id
            ORDER BY at DESC LIMIT 1) AS model
       FROM agent_usage ${where.clause}
       GROUP BY session_id
       ORDER BY cost DESC
       LIMIT @limit`
    )
    .all({ ...where.params, limit }) as SessionDetail[]
}

export interface TimelinePoint {
  bucket: string
  tokens: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
  calls: number
}

export function queryTimeline(
  filter: UsageFilter,
  granularity: 'hour' | 'day' | 'month' = 'day'
): TimelinePoint[] {
  const where = buildWhere(filter)
  const fmt =
    granularity === 'hour'
      ? "%Y-%m-%d %H:00"
      : granularity === 'month'
        ? '%Y-%m'
        : '%Y-%m-%d'
  return prepare(
      `SELECT
         strftime('${fmt}', at/1000, 'unixepoch', '+8 hours') AS bucket,
         SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
         COALESCE(SUM(input_tokens), 0) AS input,
         COALESCE(SUM(output_tokens), 0) AS output,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
         COALESCE(SUM(cost_usd), 0) AS cost,
         COUNT(*) AS calls
       FROM agent_usage ${where.clause}
       GROUP BY bucket
       ORDER BY bucket ASC`
    )
    .all(where.params) as TimelinePoint[]
}

// ========== 回顾（Wrapped） ==========
import type { UsageRecap } from '../../../../shared/types.js'

export type { UsageRecap }

const DAY_MS = 86_400_000

function utcMsOfDay(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function queryRecap(): UsageRecap {
  const summary = querySummary({})

  const range = prepare('SELECT MIN(at) AS first_at, MAX(at) AS last_at FROM agent_usage')
    .get() as { first_at: number | null; last_at: number | null }

  const byModel = prepare(
      `SELECT model,
              SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(input_tokens), 0) AS input
       FROM agent_usage
       GROUP BY model
       ORDER BY tokens DESC`
    )
    .all() as Array<{
    model: string
    tokens: number
    calls: number
    cost: number
    cache_read: number
    cached: number
    input: number
  }>

  const hourRows = prepare(
      `SELECT CAST(strftime('%H', at/1000, 'unixepoch', '+8 hours') AS INTEGER) AS h,
              COUNT(*) AS calls
       FROM agent_usage
       GROUP BY h`
    )
    .all() as Array<{ h: number; calls: number }>
  const hour_histogram = new Array<number>(24).fill(0)
  for (const r of hourRows) {
    if (r.h >= 0 && r.h <= 23) hour_histogram[r.h] = r.calls
  }

  const dayRows = prepare(
      `SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', '+8 hours') AS date,
              SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(DISTINCT agent) AS agents
       FROM agent_usage
       GROUP BY date
       ORDER BY date ASC`
    )
    .all() as Array<{ date: string; tokens: number; cost: number; agents: number }>

  let bestStreak = 0
  let run = 0
  let prev = 0
  for (const d of dayRows) {
    const t = utcMsOfDay(d.date)
    run = prev > 0 && t - prev === DAY_MS ? run + 1 : 1
    if (run > bestStreak) bestStreak = run
    prev = t
  }
  let currentStreak = 0
  if (dayRows.length > 0) {
    currentStreak = 1
    for (let i = dayRows.length - 1; i > 0; i--) {
      if (utcMsOfDay(dayRows[i]!.date) - utcMsOfDay(dayRows[i - 1]!.date) === DAY_MS) {
        currentStreak++
      } else {
        break
      }
    }
  }

  let peakDay: UsageRecap['peak_day'] = null
  for (const d of dayRows) {
    if (!peakDay || d.tokens > peakDay.tokens) {
      peakDay = { day: d.date, tokens: d.tokens, cost: d.cost }
    }
  }

  const top = byModel[0] ?? null
  const totalTokens = summary.total_tokens
  const topModel: UsageRecap['top_model'] =
    top && totalTokens > 0
      ? {
          model: top.model,
          tokens: top.tokens,
          calls: top.calls,
          cost: top.cost,
          cache_read: top.cache_read,
          cache_hit_ratio:
            top.input + top.cached > 0
              ? Math.round((top.cached / (top.input + top.cached)) * 1000) / 10
              : 0,
          share: Math.round((top.tokens / totalTokens) * 1000) / 10
        }
      : null

  return {
    totals: {
      total_tokens: summary.total_tokens,
      input_tokens: summary.input_tokens,
      output_tokens: summary.output_tokens,
      cached_tokens: summary.cached_tokens,
      cache_hit_ratio: summary.cache_hit_ratio,
      cost_usd: summary.cost_usd,
      calls: summary.calls
    },
    first_at: range.first_at,
    last_at: range.last_at,
    active_days: dayRows.length,
    peak_day: peakDay,
    top_model: topModel,
    by_model: byModel.map((m) => ({
      model: m.model,
      tokens: m.tokens,
      cost: m.cost,
      calls: m.calls
    })),
    hour_histogram,
    days: dayRows,
    streak_days: currentStreak,
    best_streak: bestStreak
  }
}

export { calcCost, priceFor, loadPricing, type ModelPrice }
