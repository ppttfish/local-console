/**
 * 解析 Worker —— 把 CPU 最重的 DSH zstd 解压 + Codex 全量解析搬离主线程
 * 主线程通过 postMessage 发任务，Worker 回包，期间主线程事件循环完全空闲
 *
 * 注意：Worker 与主线程共用 plugins/builtin/token-usage/dsh-parse.ts 里的会话解析，
 * 别再往这里拷一份（历史上拷了一份，v3 格式上线后 Worker 里那份没跟上，
 * 打包态又刚好只能走 Worker，等于 DSH 直接扫不出数据）。
 */
import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { calcCost } from '../plugins/builtin/token-usage/pricing.js'
import { parseDshFile } from '../plugins/builtin/token-usage/dsh-parse.js'

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}
function parseIsoMs(v: unknown): number {
  if (typeof v !== 'string') return 0
  if (/^\d+$/.test(v)) return parseInt(v, 10)
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : 0
}

interface DshTask {
  id: number
  type: 'dsh'
  filePath: string
  fallbackSessionId: string
}
interface CodexTask {
  id: number
  type: 'codex'
  content: string
  fallbackSessionId: string
}
interface CodexFileTask {
  id: number
  type: 'codex-file'
  filePath: string
  fallbackSessionId: string
}
type Task = DshTask | CodexTask | CodexFileTask

if (!parentPort) throw new Error('parse-worker must run as Worker')

parentPort.on('message', (task: Task) => {
  try {
    if (task.type === 'dsh') {
      const rows = parseDshFile(task.filePath, task.fallbackSessionId)
      parentPort!.postMessage({ id: task.id, ok: true, rows })
    } else if (task.type === 'codex') {
      const rows = parseCodexFromContent(task.content, task.fallbackSessionId)
      parentPort!.postMessage({ id: task.id, ok: true, rows })
    } else if (task.type === 'codex-file') {
      const content = readFileSync(task.filePath, 'utf8')
      const rows = parseCodexFromContent(content, task.fallbackSessionId)
      parentPort!.postMessage({ id: task.id, ok: true, rows })
    }
  } catch (e) {
    parentPort!.postMessage({ id: (task as Task).id, ok: false, error: String(e) })
  }
})

function parseCodexFromContent(content: string, fallbackSessionId: string) {
  const lines = content.split('\n')
  const rows: Array<Record<string, unknown>> = []
  let sessionId = fallbackSessionId
  let currentModel: string | undefined
  let prevTotal: { input: number; cached: number; cacheWrite: number; output: number; total: number } | null = null
  for (const line of lines) {
    if (!line) continue
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }
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
    let input = 0, cached = 0, cacheWrite = 0, output = 0
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
        if (curTotal < prevTotal.total || curInput < prevTotal.input || curOutput < prevTotal.output) {
          prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
          continue
        }
        input = Math.max(0, curInput - prevTotal.input)
        cached = Math.max(0, curCached - prevTotal.cached)
        cacheWrite = Math.max(0, curCacheWrite - prevTotal.cacheWrite)
        output = Math.max(0, curOutput - prevTotal.output)
      } else {
        input = curInput; cached = curCached; cacheWrite = curCacheWrite; output = curOutput
      }
      prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
      if (input + output + cached + cacheWrite === 0) continue
    } else continue
    if (useLast && total) {
      const curInput = numOr(total['input_tokens'], 0)
      const curCached = numOr(total['cached_input_tokens'], numOr(total['cache_read_input_tokens'], 0))
      const curCacheWrite = numOr(total['cache_write_input_tokens'], 0)
      const curOutput = numOr(total['output_tokens'], 0)
      const curTotal = numOr(total['total_tokens'], curInput + curOutput)
      if (curTotal > 0 || curInput > 0) {
        if (!prevTotal || curTotal >= prevTotal.total) prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
        else prevTotal = { input: curInput, cached: curCached, cacheWrite: curCacheWrite, output: curOutput, total: curTotal }
      }
    }
    if (input + output + cached + cacheWrite === 0) continue
    const fresh = Math.max(0, input - cached - cacheWrite)
    let model = currentModel ?? strOr(info['model'] as string | undefined, strOr(info['model_name'] as string | undefined, ''))
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
