/**
 * 五个 agent 的 JSONL/SQLite 解析器
 *  每个 parser 返回 UsageRow | null
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import Database from 'better-sqlite3'
import { decompress as zstdDecompress } from 'fzstd'
import type { Platform, UsageRow } from './storage.js'
import { calcCost } from './pricing.js'

export type LineParser = (
  line: string,
  ctx: ParseContext
) => UsageRow | null

export interface ParseContext {
  agent: Platform
  filePath: string
  sessionId: string
}

// ============================================================
// omp (OpenChamber)  ~/.omp/agent/sessions/**/<ts>_<sid>.jsonl
// 消息类型：{type:'message', message:{role,model,api,usage:{input,output,cacheRead,cacheWrite,totalTokens,cost:{...}}}}
// ============================================================
function parseOmpLine(line: string, ctx: ParseContext): UsageRow | null {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e['type'] !== 'message') return null
  const msg = e['message'] as Record<string, unknown> | undefined
  if (!msg || msg['role'] !== 'assistant') return null
  const usage = msg['usage'] as Record<string, unknown> | undefined
  if (!usage) return null

  const input = numOr(usage['input'], 0)
  const output = numOr(usage['output'], 0)
  const cacheRead = numOr(usage['cacheRead'], 0)
  const cacheWrite = numOr(usage['cacheWrite'], 0)
  if (input + output + cacheRead + cacheWrite === 0) return null

  const model = strOr(msg['model'] as string | undefined, 'unknown')
  // 优先用 session JSON 里的 cost；没有再算
  const costObj = usage['cost'] as Record<string, number> | undefined
  const cost =
    costObj && typeof costObj['total'] === 'number'
      ? costObj['total']
      : calcCost(model, input, output, cacheRead, cacheWrite)

  // 时间戳：顶层 timestamp 是 ISO 字符串
  const at = parseIsoMs(e['timestamp'] as string | undefined) || Date.now()

  return {
    agent: 'omp',
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cacheRead + cacheWrite,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
    at,
    session_id: ctx.sessionId,
    meta: null
  }
}

// ============================================================
// zcode  ~/.zcode/cli/rollout/model-io-sess_*.jsonl
// 单行一个 turn：{type:'model_io', model:{modelId}, response:{usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}, sessionId, startedAt}
// ============================================================
function parseZcodeLine(line: string, ctx: ParseContext): UsageRow | null {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e['type'] !== 'model_io') return null
  const response = e['response'] as Record<string, unknown> | undefined
  if (!response) return null
  const usage = response['usage'] as Record<string, unknown> | undefined
  if (!usage) return null

  const input = numOr(usage['inputTokens'], 0)
  const output = numOr(usage['outputTokens'], 0)
  const cacheRead = numOr(usage['cacheReadTokens'], 0)
  const cacheWrite = numOr(usage['cacheWriteTokens'], 0)
  if (input + output + cacheRead + cacheWrite === 0) return null

  const modelObj = e['model'] as Record<string, unknown> | undefined
  const model = strOr(modelObj?.['modelId'] as string | undefined, 'unknown')
  const cost = calcCost(model, input, output, cacheRead, cacheWrite)

  const at = parseIsoMs(e['startedAt'] as string | undefined) || Date.now()
  const sessionId =
    strOr(e['sessionId'] as string | undefined, ctx.sessionId)

  return {
    agent: 'zcode',
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cacheRead + cacheWrite,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
    at,
    session_id: sessionId,
    meta: null
  }
}

// ============================================================
// codex  ~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl
// 事件：{type:'event_msg', payload:{type:'token_count', info:{total_token_usage:{...}, last_token_usage:{...}}}}
// ============================================================
function parseCodexLine(line: string, ctx: ParseContext): UsageRow | null {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e['type'] !== 'event_msg') return null
  const payload = e['payload'] as Record<string, unknown> | undefined
  if (!payload || payload['type'] !== 'token_count') return null
  const info = payload['info'] as Record<string, unknown> | undefined
  if (!info) return null
  // last_token_usage 是当前 turn 增量；用 total_token_usage 不准（会重复统计）
  const last = info['last_token_usage'] as Record<string, number> | undefined
  if (!last) return null

  const input = numOr(last['input_tokens'], 0)
  const output = numOr(last['output_tokens'], 0)
  const cacheRead = numOr(last['cached_input_tokens'], 0)
  if (input + output + cacheRead === 0) return null

  // model 在 session_meta 里（前面行），这里拿不到；归为 codex-<context_window>
  const ctxWindow = numOr(info['model_context_window'], 0)
  const model = ctxWindow > 0 ? `codex-${ctxWindow}k` : 'codex'
  const cost = calcCost(model, input, output, cacheRead, 0)

  const at = parseIsoMs(e['timestamp'] as string | undefined) || Date.now()

  return {
    agent: 'codex',
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cacheRead,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    cost_usd: cost,
    at,
    session_id: ctx.sessionId,
    meta: null
  }
}

// ============================================================
// claude  ~/.claude/projects/<slug>/<sid>.jsonl
// 行：{type:'assistant', message:{model, usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}}}
// ============================================================
function parseClaudeLine(line: string, ctx: ParseContext): UsageRow | null {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e['type'] !== 'assistant') return null
  const msg = e['message'] as Record<string, unknown> | undefined
  if (!msg) return null
  const usage = msg['usage'] as Record<string, unknown> | undefined
  if (!usage) return null

  const input = numOr(usage['input_tokens'], 0)
  const output = numOr(usage['output_tokens'], 0)
  const cacheRead = numOr(usage['cache_read_input_tokens'], 0)
  const cacheWrite = numOr(usage['cache_creation_input_tokens'], 0)
  if (input + output + cacheRead + cacheWrite === 0) return null

  const model = strOr(msg['model'] as string | undefined, 'claude')
  const cost = calcCost(model, input, output, cacheRead, cacheWrite)

  const at = parseIsoMs(e['timestamp'] as string | undefined) || Date.now()

  return {
    agent: 'claude',
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cacheRead + cacheWrite,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
    at,
    session_id: ctx.sessionId,
    meta: null
  }
}

// ============================================================
// dsh (DeepSeek Harness)  ~/.dsh/sessions/**/session-<uuid>/session.jsonl.zstd
// 整文件 zstd 压缩，解压后按行：
//   {type:'session', id}                          → 会话 id
//   {type:'request/context', data:{model}}        → 当前 model
//   {type:'assistant/chunk', data:{chunk:{type:'usage', usage:{inputTokens,outputTokens,cacheReadTokens}}}}
// usage 跨行依赖当前 model，必须整文件解析（不能按行独立喂）
// ============================================================
export function parseDshSession(filePath: string, fallbackSessionId: string): UsageRow[] {
  if (!existsSync(filePath)) return []
  let raw: Uint8Array
  try {
    raw = zstdDecompress(readFileSync(filePath))
  } catch {
    return [] // 损坏的压缩流直接跳过，下次 mtime 变了会重试
  }
  const rows: UsageRow[] = []
  let sessionId = fallbackSessionId
  let model = 'unknown'
  for (const line of new TextDecoder().decode(raw).split('\n')) {
    if (!line) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object') continue
    const e = ev as Record<string, unknown>
    const data = (e['data'] ?? {}) as Record<string, unknown>
    const t = e['type']
    if (t === 'session') {
      sessionId = strOr(data['id'] as string | undefined, sessionId)
    } else if (t === 'request/context') {
      model = strOr(data['model'] as string | undefined, model)
    } else if (t === 'request/header') {
      const cfg = data['header'] as Record<string, unknown> | undefined
      const m = (cfg?.['config'] as Record<string, unknown> | undefined)?.['model']
      model = strOr(m as string | undefined, model)
    } else if (t === 'assistant/chunk') {
      const chunk = data['chunk'] as Record<string, unknown> | undefined
      if (!chunk || chunk['type'] !== 'usage') continue
      const usage = chunk['usage'] as Record<string, unknown> | undefined
      if (!usage) continue
      const input = numOr(usage['inputTokens'], 0)
      const output = numOr(usage['outputTokens'], 0)
      const cacheRead = numOr(usage['cacheReadTokens'], 0)
      if (input + output + cacheRead === 0) continue
      rows.push({
        agent: 'dsh',
        model,
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cacheRead,
        cache_read_tokens: cacheRead,
        cache_write_tokens: 0,
        cost_usd: calcCost(model, input, output, cacheRead, 0),
        at: numOr(e['time'], Date.now()),
        session_id: sessionId,
        meta: null
      })
    }
  }
  return rows
}

// ============================================================
// utils
// ============================================================
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}
function parseIsoMs(v: unknown): number {
  if (typeof v !== 'string') return 0
  if (/^\d+$/.test(v)) return parseInt(v, 10) // 已是毫秒
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : 0
}

// ============================================================
// OpenCode 用 SQLite 直查，不走 jsonl
// ~/.local/share/opencode/opencode.db
// message.data: JSON {role:'assistant', modelID, providerID, tokens:{input,output,cache:{read,write}}, cost:{...}}
// ============================================================
export interface OpenCodeRow {
  session_id: string
  model: string
  provider: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
  at: number
}

export function readOpenCodeDb(dbPath: string): OpenCodeRow[] {
  if (!existsSync(dbPath)) return []
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return []
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, session_id, time_created, data
         FROM message
         WHERE data LIKE '%assistant%' AND data LIKE '%tokens%'`
      )
      .all() as Array<{
      id: string
      session_id: string
      time_created: number
      data: string
    }>
    const out: OpenCodeRow[] = []
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as Record<string, unknown>
        if (d['role'] !== 'assistant') continue
        const tokens = d['tokens'] as Record<string, number> | undefined
        if (!tokens) continue
        const cache = (typeof tokens['cache'] === 'object' && tokens['cache'] !== null
          ? (tokens['cache'] as Record<string, number>)
          : undefined)
        const input = numOr(tokens['input'], 0)
        const output = numOr(tokens['output'], 0)
        const cacheRead = numOr(cache?.['read'], 0)
        const cacheWrite = numOr(cache?.['write'], 0)
        if (input + output + cacheRead + cacheWrite === 0) continue
        const model = strOr(d['modelID'] as string | undefined, 'unknown')
        const provider = strOr(d['providerID'] as string | undefined, '')
        const costObj = d['cost'] as Record<string, number> | undefined
        const cost =
          costObj && typeof costObj['total'] === 'number'
            ? costObj['total']
            : calcCost(model, input, output, cacheRead, cacheWrite)
        out.push({
          session_id: r.session_id,
          model: provider ? `${provider}/${model}` : model,
          provider,
          input,
          output,
          cache_read: cacheRead,
          cache_write: cacheWrite,
          cost,
          at: r.time_created
        })
      } catch {
        // 忽略单行解析错
      }
    }
    return out
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}

// ============================================================
// 文件类型分发
// ============================================================
export function parserForFile(agent: Platform, filePath: string): LineParser | null {
  // omp / zcode / codex / claude 都用 .jsonl
  if (!filePath.endsWith('.jsonl')) return null
  switch (agent) {
    case 'omp':
      return parseOmpLine
    case 'zcode':
      return parseZcodeLine
    case 'codex':
      return parseCodexLine
    case 'claude':
      return parseClaudeLine
    default:
      return null
  }
}

export function sessionIdFromFile(agent: Platform, filePath: string): string {
  const base = basename(filePath, '.jsonl')
  switch (agent) {
    case 'zcode':
      // model-io-sess_<id> -> sess_<id>
      return base.replace(/^model-io-/, '')
    case 'omp': {
      // 2026-08-25T14-17-32-316Z_01a03948-919c-70d2-944c-418261ef4c84
      const parts = base.split('_')
      return parts[parts.length - 1] ?? base
    }
    case 'dsh':
      // session-<uuid>/session.jsonl.zstd —— 会话 id 在目录名上
      return basename(dirname(filePath))
    case 'codex':
    case 'claude':
      return base
    default:
      return base
  }
}

void statSync
void readFileSync
void readdirSync
void join
