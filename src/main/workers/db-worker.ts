/**
 * DB 读 Worker —— 把所有 agent_usage 重聚合查询搬离主线程
 * 主线程的 better-sqlite3 同步查询（80~200ms）会定住事件循环，本 Worker 用独立只读连接执行
 */
import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'

let db: Database.Database | null = null
let dbPath: string | null = null
const stmtCache = new Map<string, Database.Statement>()

function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized in worker')
  return db
}
function prepare(sql: string): Database.Statement {
  const hit = stmtCache.get(sql)
  if (hit) return hit
  const stmt = getDb().prepare(sql)
  stmtCache.set(sql, stmt)
  return stmt
}

function buildWhere(filter: { agent?: string; model?: string; from?: number; to?: number }) {
  const conds: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.agent && filter.agent !== 'all') { conds.push('agent = @agent'); params.agent = filter.agent }
  if (filter.model) { conds.push('model = @model'); params.model = filter.model }
  if (typeof filter.from === 'number') { conds.push('at >= @from'); params.from = filter.from }
  if (typeof filter.to === 'number') { conds.push('at <= @to'); params.to = filter.to }
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params }
}

function querySummary(filter: { agent?: string; model?: string; from?: number; to?: number }) {
  const where = buildWhere(filter)
  const totals = prepare(
    `SELECT COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS out, COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls FROM agent_usage ${where.clause}`
  ).get(where.params) as { inp:number; out:number; cached:number; cr:number; cw:number; cost:number; calls:number }
  const byAgent = prepare(
    `SELECT agent, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM agent_usage ${where.clause} GROUP BY agent ORDER BY cost DESC`
  ).all(where.params)
  const byModel = prepare(
    `SELECT model, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cache_write_tokens),0) AS cache_write FROM agent_usage ${where.clause} GROUP BY model ORDER BY cost DESC LIMIT 50`
  ).all(where.params)
  const byDay = prepare(
    `SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', '+8 hours') AS day, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM agent_usage ${where.clause} GROUP BY day ORDER BY day ASC`
  ).all(where.params)
  const inp = totals.inp ?? 0
  const cached = totals.cached ?? 0
  const cacheHit = inp+cached>0 ? Math.round((cached/(inp+cached))*1000)/10 : 0
  return {
    total_tokens: inp + (totals.out??0) + cached,
    input_tokens: inp,
    output_tokens: totals.out??0,
    cached_tokens: cached,
    cache_read_tokens: totals.cr??0,
    cache_write_tokens: totals.cw??0,
    cache_hit_ratio: cacheHit,
    cost_usd: totals.cost??0,
    calls: totals.calls??0,
    by_agent: byAgent,
    by_model: byModel,
    by_day: byDay
  }
}

function queryTimeline(filter: { agent?: string; model?: string; from?: number; to?: number }, granularity: string) {
  const where = buildWhere(filter)
  const fmt = granularity==='hour' ? "%Y-%m-%d %H:00" : granularity==='month' ? '%Y-%m' : '%Y-%m-%d'
  return prepare(
    `SELECT strftime('${fmt}', at/1000, 'unixepoch', '+8 hours') AS bucket, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cache_write_tokens),0) AS cache_write, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls FROM agent_usage ${where.clause} GROUP BY bucket ORDER BY bucket ASC`
  ).all(where.params)
}

function listSessions(filter: { agent?: string; model?: string; from?: number; to?: number }, limit:number) {
  const where = buildWhere(filter)
  const base = prepare(
    `SELECT session_id, MAX(agent) AS agent, MIN(at) AS first_at, MAX(at) AS last_at, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COALESCE(SUM(cost_usd),0) AS cost FROM agent_usage ${where.clause} GROUP BY session_id ORDER BY cost DESC LIMIT @limit`
  ).all({ ...where.params, limit }) as Array<{ session_id:string; agent:string; first_at:number; last_at:number; calls:number; tokens:number; cost:number }>
  if (base.length===0) return []
  const ids = base.map(r=>r.session_id)
  const placeholders = ids.map(()=>'?').join(',')
  const winRows = prepare(
    `SELECT session_id, model FROM (SELECT session_id, model, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY at DESC) AS rn FROM agent_usage WHERE session_id IN (${placeholders})) WHERE rn=1`
  ).all(...ids) as Array<{ session_id:string; model:string }>
  const map = new Map(winRows.map(r=>[r.session_id, r.model]))
  return base.map(r=> ({ ...r, model: map.get(r.session_id) ?? null }))
}

function queryRecap() {
  const summary = querySummary({})
  const range = prepare('SELECT MIN(at) AS first_at, MAX(at) AS last_at FROM agent_usage').get() as { first_at:number|null; last_at:number|null }
  const byModel = prepare(`SELECT model, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(SUM(input_tokens),0) AS input FROM agent_usage GROUP BY model ORDER BY tokens DESC`).all() as Array<{ model:string; tokens:number; calls:number; cost:number; cache_read:number; cached:number; input:number }>
  const hourRows = prepare(`SELECT CAST(strftime('%H', at/1000, 'unixepoch', '+8 hours') AS INTEGER) AS h, COUNT(*) AS calls FROM agent_usage GROUP BY h`).all() as Array<{ h:number; calls:number }>
  const hour_histogram = new Array<number>(24).fill(0)
  for (const r of hourRows) if (r.h>=0&&r.h<=23) hour_histogram[r.h]=r.calls
  const dayRows = prepare(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', '+8 hours') AS date, SUM(input_tokens+output_tokens+cached_tokens) AS tokens, COALESCE(SUM(cost_usd),0) AS cost, COUNT(DISTINCT agent) AS agents FROM agent_usage GROUP BY date ORDER BY date ASC`).all() as Array<{ date:string; tokens:number; cost:number; agents:number }>
  const DAY_MS=86400000
  const utcMsOfDay=(d:string)=>{ const [y,m,da]=d.split('-').map(Number); return Date.UTC(y??1970,(m??1)-1,da??1)}
  let bestStreak=0, run=0, prev=0
  for (const d of dayRows){ const t=utcMsOfDay(d.date); run= prev>0 && t-prev===DAY_MS ? run+1:1; if(run>bestStreak) bestStreak=run; prev=t }
  let currentStreak=0
  if(dayRows.length>0){ currentStreak=1; for(let i=dayRows.length-1;i>0;i--){ if(utcMsOfDay(dayRows[i]!.date)-utcMsOfDay(dayRows[i-1]!.date)===DAY_MS) currentStreak++; else break}}
  let peakDay: { day:string; tokens:number; cost:number }|null=null
  for(const d of dayRows) if(!peakDay||d.tokens>peakDay.tokens) peakDay={day:d.date,tokens:d.tokens,cost:d.cost}
  const top=byModel[0]??null
  const totalTokens=summary.total_tokens
  const topModel= top&&totalTokens>0 ? { model:top.model, tokens:top.tokens, calls:top.calls, cost:top.cost, cache_read:top.cache_read, cache_hit_ratio: top.input+top.cached>0 ? Math.round((top.cached/(top.input+top.cached))*1000)/10:0, share: Math.round((top.tokens/totalTokens)*1000)/10 } : null
  return { totals: { total_tokens:summary.total_tokens, input_tokens:summary.input_tokens, output_tokens:summary.output_tokens, cached_tokens:summary.cached_tokens, cache_hit_ratio:summary.cache_hit_ratio, cost_usd:summary.cost_usd, calls:summary.calls }, first_at:range.first_at, last_at:range.last_at, active_days:dayRows.length, peak_day:peakDay, top_model:topModel, by_model:byModel.map(m=>({model:m.model,tokens:m.tokens,cost:m.cost,calls:m.calls})), hour_histogram, days:dayRows, streak_days:currentStreak, best_streak:bestStreak }
}

if (!parentPort) throw new Error('db-worker must run as Worker')

parentPort.on('message', (msg: { id:number; type:string; dbPath?:string; filter?:unknown; granularity?:string; limit?:number }) => {
  try {
    if (msg.type==='init') {
      const p = msg.dbPath!
      if (dbPath !== p) {
        if (db) { try{ db.close()}catch{} db=null }
        dbPath = p
        db = new Database(dbPath, { readonly:true, fileMustExist:false })
        try{ db.pragma('journal_mode = WAL')}catch{}
        try{ db.pragma('busy_timeout = 5000')}catch{}
        try{ db.pragma('cache_size = -64000')}catch{}
        try{ db.pragma('temp_store = MEMORY')}catch{}
        try{ db.pragma('mmap_size = 268435456')}catch{}
        stmtCache.clear()
      }
      parentPort!.postMessage({ id: msg.id, ok:true })
      return
    }
    if (!db) throw new Error('DB not initialized')
    let result: unknown
    if (msg.type==='summary') result = querySummary(msg.filter as never)
    else if (msg.type==='timeline') result = queryTimeline(msg.filter as never, msg.granularity as string)
    else if (msg.type==='sessions') result = listSessions(msg.filter as never, msg.limit as number)
    else if (msg.type==='recap') result = queryRecap()
    else if (msg.type==='legacy') {
      const r = prepare('SELECT COUNT(*) AS n FROM agent_usage WHERE source_file IS NULL').get() as { n:number }
      result = r.n ?? 0
    }
    else throw new Error('unknown type '+msg.type)
    parentPort!.postMessage({ id: msg.id, ok:true, result })
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok:false, error: String(e) })
  }
})
