/**
 * 五个 agent 的 JSONL/SQLite 解析器
 *  每个 parser 返回 UsageRow | null
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import Database from 'better-sqlite3'
import { decompress as zstdDecompress } from 'fzstd'
import type { Platform, UsageRow } from './storage.js'
import { calcCost } from './pricing.js'

/**
 * 解析器产出的行：不含 source_file。
 * 来源文件由扫描器在入库前统一盖上，解析器不必关心自己被哪个文件调用。
 */
export type ParsedUsageRow = Omit<UsageRow, 'source_file'>

export type LineParser = (
  line: string,
  ctx: ParseContext
) => ParsedUsageRow | null

export interface ParseContext {
  agent: Platform
  filePath: string
  sessionId: string
}

// ============================================================
// omp (OpenChamber)  ~/.omp/agent/sessions/**/<ts>_<sid>.jsonl
// 消息类型：{type:'message', message:{role,model,api,usage:{input,output,cacheRead,cacheWrite,totalTokens,cost:{...}}}}
// ============================================================
function parseOmpLine(line: string, ctx: ParseContext): ParsedUsageRow | null {
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

  // omp 的 usage.input 为 fresh（不含缓存），totalTokens = 四项之和。
  // 为与 codeburn 的 fresh 存储统一，此处保留 fresh，不再并入 cached
  // 成本计算亦按 fresh + cached 分桶，避免对 ZCode/Codex 的 inclusive 口径重复计费
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
function parseZcodeLine(line: string, ctx: ParseContext): ParsedUsageRow | null {
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

  const rawInput = numOr(usage['inputTokens'], 0)
  const output = numOr(usage['outputTokens'], 0)
  const cacheRead = numOr(usage['cacheReadTokens'], 0)
  const cacheWrite = numOr(usage['cacheWriteTokens'], 0)
  if (rawInput + output + cacheRead + cacheWrite === 0) return null
  // 同 DB 口径：rollout 的 inputTokens 同样已包含缓存命中，本处扣减后仅 fresh 计 input 价
  const freshInput = Math.max(0, rawInput - cacheRead - cacheWrite)

  const modelObj = e['model'] as Record<string, unknown> | undefined
  const model = strOr(modelObj?.['modelId'] as string | undefined, 'unknown')
  const cost = calcCost(model, freshInput, output, cacheRead, cacheWrite)

  const at = parseIsoMs(e['startedAt'] as string | undefined) || Date.now()
  const sessionId =
    strOr(e['sessionId'] as string | undefined, ctx.sessionId)

  return {
    agent: 'zcode',
    model,
    input_tokens: freshInput,
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
// 事件：{type:'event_msg', payload:{type:'token_count', info:{total_token_usage, last_token_usage}}}
// 统计口径参考 skiplevel / codeburn：
//  - 优先 last_token_usage（per-turn 增量）；老文件仅有 total_token_usage 时按增量差值
//  - cached_input_tokens （含老拼写 cache_read_input_tokens）与 cache_write_input_tokens 均为 input 子集
//  - reasoning_output_tokens 已含于 output_tokens，勿重复加
//  - model 以 turn_context 的 model 为权威，info.model 兜底
// ============================================================
function parseCodexLine(line: string, ctx: ParseContext): ParsedUsageRow | null {
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
  const last = info['last_token_usage'] as Record<string, number> | undefined
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  if (last) {
    input = numOr(last['input_tokens'], 0)
    output = numOr(last['output_tokens'], 0)
    cacheRead = numOr(last['cached_input_tokens'], numOr(last['cache_read_input_tokens'], 0))
    cacheWrite = numOr(last['cache_write_input_tokens'], 0)
  } else {
    // 老文件仅有 total_token_usage —— 调用方应走 parseCodexSession 做增量差值，单行无法准确
    return null
  }
  if (input + output + cacheRead + cacheWrite === 0) return null

  // cached / cache_write 均已含于 input，需扣减后仅 fresh 按 input 价计费（codeburn / skiplevel 口径）
  const fresh = Math.max(0, input - cacheRead - cacheWrite)
  const model =
    strOr((info as Record<string, unknown>)['model'] as string | undefined,
      strOr((info as Record<string, unknown>)['model_name'] as string | undefined,
        (() => {
          const w = numOr(info['model_context_window'], 0)
          return w > 0 ? `codex-${w}k` : 'codex'
        })()))
  const cost = calcCost(model, fresh, output, cacheRead, cacheWrite)

  const at = parseIsoMs(e['timestamp'] as string | undefined) || Date.now()

  return {
    agent: 'codex',
    model,
    input_tokens: fresh,
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

/**
 * Codex 整文件解析（有状态）—— 正确处理 turn_context 模型与 total_token_usage 增量。
 * scanner 对 codex 文件应优先用此函数，而非逐行 parserForFile。
 */
export function parseCodexSession(filePath: string, fallbackSessionId: string): ParsedUsageRow[] {
  if (!existsSync(filePath)) return []
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  return parseCodexSessionFromContent(content, fallbackSessionId)
}

export function parseCodexSessionFromContent(content: string, fallbackSessionId: string): ParsedUsageRow[] {
  const lines = content.split('\n')
  const rows: ParsedUsageRow[] = []
  let sessionId = fallbackSessionId
  let currentModel: string | undefined
  // 累计增量的上一次快照（用于 total 兜底）
  let prevTotal: { input: number; cached: number; cacheWrite: number; output: number; total: number } | null = null

  for (const line of lines) {
    if (!line) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object') continue
    const e = ev as Record<string, unknown>
    const t = e['type'] as string | undefined
    const payload = e['payload'] as Record<string, unknown> | undefined
    if (t === 'session_meta' && payload) {
      const id = payload['id'] as string | undefined
      if (id) sessionId = id
      const m = payload['model'] as string | undefined
      if (m) currentModel = m
      continue
    }
    if (t === 'turn_context' && payload) {
      const m = payload['model'] as string | undefined
      if (m) currentModel = m
      continue
    }
    if (t !== 'event_msg' || !payload || payload['type'] !== 'token_count') continue
    const info = payload['info'] as Record<string, unknown> | undefined
    if (!info) continue
    const last = info['last_token_usage'] as Record<string, unknown> | undefined
    const total = info['total_token_usage'] as Record<string, unknown> | undefined
    let input = 0
    let cached = 0
    let cacheWrite = 0
    let output = 0
    let useLast = false
    if (last && (numOr(last['input_tokens'], 0) + numOr(last['output_tokens'], 0) + numOr(last['cached_input_tokens'], numOr(last['cache_read_input_tokens'], 0)) > 0)) {
      input = numOr(last['input_tokens'], 0)
      cached = numOr(last['cached_input_tokens'], numOr(last['cache_read_input_tokens'], 0))
      cacheWrite = numOr(last['cache_write_input_tokens'], 0)
      output = numOr(last['output_tokens'], 0)
      useLast = true
    } else if (total) {
      const curInput = numOr(total['input_tokens'], 0)
      const curCached = numOr(total['cached_input_tokens'], numOr(total['cache_read_input_tokens'], 0))
      const curCacheWrite = numOr(total['cache_write_input_tokens'], 0)
      const curOutput = numOr(total['output_tokens'], 0)
      const curTotal = numOr(total['total_tokens'], curInput + curOutput)
      if (prevTotal) {
        // 回退检测：若任何累计值回退，视为压缩/分叉重置，本次不清费并重建基线
        if (curTotal < prevTotal.total || curInput < prevTotal.input || curOutput < prevTotal.output) {
          prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
          continue
        }
        input = Math.max(0, curInput - prevTotal.input)
        cached = Math.max(0, curCached - prevTotal.cached)
        cacheWrite = Math.max(0, curCacheWrite - prevTotal.cacheWrite)
        output = Math.max(0, curOutput - prevTotal.output)
      } else {
        // 首条 total 即当作增量（老文件首行即全量）
        input = curInput
        cached = curCached
        cacheWrite = curCacheWrite
        output = curOutput
      }
      prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
      // 仅有 total 时已用增量，后续若下行为 last 则不再更新 prevTotal（保持累计基准）
      if (input + output + cached + cacheWrite === 0) continue
    } else {
      continue
    }
    if (useLast && total) {
      // 同步更新累计基线，供后续 total 兜底增量
      const curInput = numOr(total['input_tokens'], 0)
      const curCached = numOr(total['cached_input_tokens'], numOr(total['cache_read_input_tokens'], 0))
      const curCacheWrite = numOr(total['cache_write_input_tokens'], 0)
      const curOutput = numOr(total['output_tokens'], 0)
      const curTotal = numOr(total['total_tokens'], curInput + curOutput)
      if (curTotal > 0 || curInput > 0) {
        // 若累计回退则重建基线
        if (!prevTotal || curTotal >= prevTotal.total) {
          prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
        } else {
          prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
        }
      }
    } else if (useLast && !total && prevTotal) {
      // 仅有 last 的文件，累计基准无法更新，保持不变
    }

    if (input + output + cached + cacheWrite === 0) continue
    const fresh = Math.max(0, input - cached - cacheWrite)
    let model = currentModel
      ?? strOr(info['model'] as string | undefined, strOr(info['model_name'] as string | undefined, ''))
    if (!model) {
      const w = numOr(info['model_context_window'], 0)
      model = w > 0 ? `codex-${w}k` : 'codex'
    }
    const at = parseIsoMs(e['timestamp'] as string | undefined) || Date.now()
    rows.push({
      agent: 'codex',
      model,
      input_tokens: fresh,
      output_tokens: output,
      cached_tokens: cached + cacheWrite,
      cache_read_tokens: cached,
      cache_write_tokens: cacheWrite,
      cost_usd: calcCost(model, fresh, output, cached, cacheWrite),
      at,
      session_id: sessionId,
      meta: null
    })
  }
  return rows
}

// ============================================================
// claude  ~/.claude/projects/<slug>/<sid>.jsonl
// 行：{type:'assistant', message:{model, usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}}}
// ============================================================
function parseClaudeLine(line: string, ctx: ParseContext): ParsedUsageRow | null {
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
  // 兼容 cache_creation 的 5m/1h 拆分（ccusage#899）：优先读细分，否则回退到总量
  const cacheCreationObj = usage['cache_creation'] as Record<string, unknown> | undefined
  let cacheWrite5m = 0
  let cacheWrite1h = 0
  if (cacheCreationObj && (typeof cacheCreationObj['ephemeral_5m_input_tokens'] === 'number' || typeof cacheCreationObj['ephemeral_1h_input_tokens'] === 'number')) {
    cacheWrite5m = numOr(cacheCreationObj['ephemeral_5m_input_tokens'], 0)
    cacheWrite1h = numOr(cacheCreationObj['ephemeral_1h_input_tokens'], 0)
  } else {
    // 老文件仅有总量，默认按 5m 计（兼容期），但多数为 1h，会在定价层按 5m 价低估约 37%，
    // 后续可通过 pricing 的 cache_write_1h 推导差额；此处保留原始总量作 5m
    cacheWrite5m = numOr(usage['cache_creation_input_tokens'], 0)
    cacheWrite1h = 0
  }
  const cacheWrite = cacheWrite5m + cacheWrite1h
  if (input + output + cacheRead + cacheWrite === 0) return null

  const model = strOr(msg['model'] as string | undefined, 'claude')
  const cost = calcCost(model, input, output, cacheRead, cacheWrite5m, cacheWrite1h)

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
export function parseDshSession(
  filePath: string,
  fallbackSessionId: string
): Array<ParsedUsageRow & { seq?: number }> {
  if (!existsSync(filePath)) return []
  let raw: Uint8Array
  try {
    raw = zstdDecompress(readFileSync(filePath))
  } catch {
    return [] // 损坏的压缩流直接跳过，下次 mtime 变了会重试
  }
  const rows: Array<ParsedUsageRow & { seq?: number }> = []
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
      sessionId = strOr(e['id'] as string | undefined, sessionId)
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
        meta: null,
        seq: typeof e['seq'] === 'number' ? e['seq'] : undefined
      })
    }
  }
  return rows
}

/** 异步版：文件读取走 fs/promises，不阻塞主线程；解压仍为同步（fzstd 纯 JS），但已在 scanner 的让出切片中 */
export async function parseDshSessionAsync(
  filePath: string,
  fallbackSessionId: string
): Promise<Array<ParsedUsageRow & { seq?: number }>> {
  if (!existsSync(filePath)) return []
  let raw: Uint8Array
  try {
    const buf = await readFileAsync(filePath)
    raw = zstdDecompress(buf)
  } catch {
    return []
  }
  const rows: Array<ParsedUsageRow & { seq?: number }> = []
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
      // id 在事件顶层，不在 data 里
      sessionId = strOr(e['id'] as string | undefined, sessionId)
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
      // dsh 的 totalTokens = inputTokens + outputTokens + cacheReadTokens，
      // 即 inputTokens 为 fresh（不含缓存命中），与 omp 同口径，无需扣减
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
        meta: null,
        seq: typeof e['seq'] === 'number' ? e['seq'] : undefined
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

/**
 * @param sinceMs 只取 time_created >= sinceMs 的消息。
 *   opencode 走「全删全写」，所以传入当前库里已有 opencode 行的最早时间即可，
 *   opencode.db 每变一次 mtime 就要重跑一遍，不设下界会让全表扫随时间线性变慢。
 */
export function readOpenCodeDb(dbPath: string, sinceMs = 0): OpenCodeRow[] {
  if (!existsSync(dbPath)) return []
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return []
  }
  try {
    // 不再用 data LIKE '%assistant%' AND data LIKE '%tokens%' 过滤：
    // 两个前置通配符的 LIKE 无法走索引，等于对每行几百 KB 的 JSON 做全表字符串匹配，
    // 而 role/tokens 本来就在下面的 JSON.parse 之后判空，过滤是重复的。
    const rows = db
      .prepare(
        `SELECT id, session_id, time_created, data
         FROM message
         WHERE time_created >= ?`
      )
      .all(sinceMs) as Array<{
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
        const tokens = d['tokens'] as unknown as Record<string, unknown> | undefined
        if (!tokens) continue
        const cache = (typeof (tokens as Record<string, unknown>)['cache'] === 'object' && (tokens as Record<string, unknown>)['cache'] !== null
          ? ((tokens as Record<string, unknown>)['cache'] as Record<string, number>)
          : undefined)
        const input = numOr((tokens as Record<string, number>)['input'], 0)
        // reasoning 与 output 分桶（skiplevel：reasoning 单独计，计费按 output 价）
        const outputBase = numOr((tokens as Record<string, number>)['output'], 0)
        const reasoning = numOr((tokens as Record<string, number>)['reasoning'], 0)
        const output = outputBase + reasoning
        const cacheRead = numOr(cache?.['read'], 0)
        const cacheWrite = numOr(cache?.['write'], 0)
        if (input + output + cacheRead + cacheWrite === 0) continue
        const model = strOr(d['modelID'] as string | undefined, 'unknown')
        const provider = strOr(d['providerID'] as string | undefined, '')
        // opencode 自身 cost 曾漏算 cache_read（issue #28494），导致显示成本低 2~3 倍
        // 此处优先按定价重算；仅当定价缺失（返回 0）且原始 cost 存在时回退到原始值
        const calc = calcCost(model, input, output, cacheRead, cacheWrite)
        const costObj = d['cost'] as Record<string, number> | undefined
        const stored = costObj && typeof costObj['total'] === 'number' ? costObj['total'] : 0
        const cost = calc > 0 ? calc : stored
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


// ============================================================
// zcode 权威用量源  ~/.zcode/cli/db/db.sqlite 的 model_usage 表
//
// rollout 的 model-io jsonl 会被 ZCode 压缩/清理，transcript 只有子会话记录，
// 只有 db.sqlite 的 model_usage 保留全部（主 + 子）会话的完整用量：
//   列: session_id, model_id, input_tokens, output_tokens,
//       cache_read_input_tokens, cache_creation_input_tokens, started_at(ms)
// 这是 zcode 数据的唯一权威来源，扫描器对它全删全写。
// ============================================================
export interface ZcodeUsageRow {
  session_id: string
  model: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
  at: number
}

export function readZcodeDb(dbPath: string): ZcodeUsageRow[] {
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
        `SELECT session_id, model_id, input_tokens, output_tokens, reasoning_tokens,
                cache_read_input_tokens, cache_creation_input_tokens, started_at, completed_at
         FROM model_usage
         WHERE status = 'completed'
           AND (input_tokens + output_tokens + COALESCE(reasoning_tokens,0) + cache_read_input_tokens + cache_creation_input_tokens) > 0`
      )
      .all() as Array<{
      session_id: string | null
      model_id: string | null
      input_tokens: number | null
      output_tokens: number | null
      reasoning_tokens: number | null
      cache_read_input_tokens: number | null
      cache_creation_input_tokens: number | null
      started_at: number | null
      completed_at: number | null
    }>
    const out: ZcodeUsageRow[] = []
    for (const r of rows) {
      const rawInput = numOr(r.input_tokens, 0)
      const cr = numOr(r.cache_read_input_tokens, 0)
      const cw = numOr(r.cache_creation_input_tokens, 0)
      // ZCode 的 input_tokens 是全量 prompt（含缓存命中/写入），参考 codeburn：
      // input_tokens = 36 fresh + 64 cached 时，计费应为 fresh*input价 + cached*cache价
      // 若直接用 rawInput 按 input 价全额计费，会把 cached 部分重复按原价算一次，成本虚高 30~90%
      const freshInput = Math.max(0, rawInput - cr - cw)
      const output = numOr(r.output_tokens, 0) + numOr(r.reasoning_tokens, 0)
      if (freshInput + output + cr + cw === 0) continue
      const model = strOr(r.model_id, 'unknown')
      out.push({
        session_id: strOr(r.session_id, 'unknown'),
        model,
        input: freshInput,
        output,
        cache_read: cr,
        cache_write: cw,
        cost: calcCost(model, freshInput, output, cr, cw),
        at: numOr(r.completed_at, 0) || numOr(r.started_at, 0)
      })
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
