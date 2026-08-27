/**
 * token-usage 数据层 v2 —— 支持 cost_usd + cache 读/写分桶
 */
import { getDb } from '../../../services/db.js'
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
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON agent_usage(at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON agent_usage(agent);
CREATE INDEX IF NOT EXISTS idx_usage_model ON agent_usage(model);
CREATE INDEX IF NOT EXISTS idx_usage_agent_at ON agent_usage(agent, at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON agent_usage(session_id);

CREATE TABLE IF NOT EXISTS agent_file_cursor (
  file_path TEXT PRIMARY KEY,
  file_size INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL,
  lines_seen INTEGER NOT NULL DEFAULT 0
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
}

export function insertUsageBatch(rows: UsageRow[]): number {
  if (rows.length === 0) return 0
  const stmt = getDb().prepare(
    `INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens, cost_usd, at, session_id, meta)
     VALUES (@agent, @model, @input_tokens, @output_tokens, @cached_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd, @at, @session_id, @meta)`
  )
  const tx = getDb().transaction((items: UsageRow[]) => {
    for (const r of items) stmt.run(r)
  })
  tx(rows)
  return rows.length
}

// ========== Cursor ==========
interface CursorRow {
  file_path: string
  file_size: number
  file_mtime: number
  lines_seen: number
}

export function getCursor(filePath: string): CursorRow | null {
  const r = getDb()
    .prepare('SELECT * FROM agent_file_cursor WHERE file_path = ?')
    .get(filePath) as CursorRow | undefined
  return r ?? null
}

export function upsertCursor(
  filePath: string,
  size: number,
  mtime: number,
  linesSeen: number
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_file_cursor (file_path, file_size, file_mtime, lines_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_size = excluded.file_size,
         file_mtime = excluded.file_mtime,
         lines_seen = excluded.lines_seen`
    )
    .run(filePath, size, mtime, linesSeen)
}

export function resetCursor(filePath: string): void {
  getDb()
    .prepare('DELETE FROM agent_file_cursor WHERE file_path = ?')
    .run(filePath)
}

export function resetAllCursors(): void {
  getDb().prepare('DELETE FROM agent_file_cursor').run()
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
  const totals = getDb()
    .prepare(
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

  const byAgent = getDb()
    .prepare(
      `SELECT agent,
              SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM agent_usage ${where.clause}
       GROUP BY agent
       ORDER BY cost DESC`
    )
    .all(where.params) as Array<{ agent: string; tokens: number; calls: number; cost: number }>

  const byModel = getDb()
    .prepare(
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

  const byDay = getDb()
    .prepare(
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
    getDb()
      .prepare('SELECT DISTINCT model FROM agent_usage ORDER BY model ASC')
      .all() as Array<{ model: string }>
  ).map((r) => r.model)
}

export function listDistinctAgents(): Platform[] {
  return (
    getDb()
      .prepare('SELECT DISTINCT agent FROM agent_usage ORDER BY agent ASC')
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
  return getDb()
    .prepare(
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
  return getDb()
    .prepare(
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

export { calcCost, priceFor, loadPricing, type ModelPrice }
