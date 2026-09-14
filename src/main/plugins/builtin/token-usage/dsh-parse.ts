/**
 * DSH (DeepSeek Harness) 会话解析 —— 主进程与 parse-worker 共用同一份实现
 *
 * 会话文件：~/.dsh/sessions/<project>/session-<uuid>/session.jsonl.zstd
 * 整文件 zstd 压缩，解压后逐行 JSON。usage 事件有两代格式：
 *
 *  v2（~2026-09-07 之前）
 *    {type:'request/context', data:{model}}
 *    {type:'assistant/chunk', data:{chunk:{type:'usage', usage:{inputTokens,outputTokens,cacheReadTokens}}}}
 *    {type:'session', id}
 *
 *  v3（session.v3.jsonl.zstd，2026-09 起；DSH 升级后 v2 的 usage 事件彻底消失）
 *    {type:'request/header', data:{header:{config:{provider,model}}}}
 *    {type:'assistant/message', data:{message:{source:{provider,model}}, usage:{inputTokens,outputTokens,cacheReadTokens,reasoningTokens,totalTokens}}}
 *
 * v3 的 totalTokens = inputTokens + outputTokens + cacheReadTokens，
 * 即 inputTokens 已是「不含缓存命中的 fresh input」，与 omp 同口径、无需扣减；
 * reasoningTokens 含在 outputTokens 内。
 *
 * 历史坑：老解析器只认 assistant/chunk，DSH 升到 v3 之后 ~/.dsh 再也扫不出任何用量
 * （DB 里 dsh 最后一条停在 2026-09-07），这里两代格式都支持。
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { decompress as zstdDecompress } from 'fzstd'
import { calcCost } from './pricing.js'
import type { UsageRow } from './storage.js'

/** 不含 source_file（扫描器入库前统一盖），seq 用于会话内去重 */
export type DshUsageRow = Omit<UsageRow, 'source_file'> & { seq?: number }

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

/**
 * 解析已解压的会话文本。纯函数，Worker / 主线程共用。
 */
export function parseDshText(text: string, fallbackSessionId: string): DshUsageRow[] {
  const rows: DshUsageRow[] = []
  let sessionId = fallbackSessionId
  let model = 'unknown'
  for (const line of text.split('\n')) {
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
      sessionId = strOr(e['id'], sessionId)
      continue
    }
    if (t === 'request/context') {
      model = strOr(data['model'], model)
      continue
    }
    if (t === 'request/header') {
      const cfg = data['header'] as Record<string, unknown> | undefined
      const m = (cfg?.['config'] as Record<string, unknown> | undefined)?.['model']
      model = strOr(m, model)
      continue
    }

    let usage: Record<string, unknown> | undefined
    let rowModel = model
    if (t === 'assistant/message') {
      // v3：usage 挂在 assistant/message 上，模型在 message.source 里
      usage = data['usage'] as Record<string, unknown> | undefined
      const source = (data['message'] as Record<string, unknown> | undefined)?.['source'] as
        | Record<string, unknown>
        | undefined
      rowModel = strOr(source?.['model'], model)
      model = rowModel
    } else if (t === 'assistant/chunk') {
      // v2：usage 在 chunk.type === 'usage' 的 chunk 上
      const chunk = data['chunk'] as Record<string, unknown> | undefined
      if (!chunk || chunk['type'] !== 'usage') continue
      usage = chunk['usage'] as Record<string, unknown> | undefined
    } else {
      continue
    }
    if (!usage) continue

    const input = numOr(usage['inputTokens'], 0)
    const output = numOr(usage['outputTokens'], 0)
    const cacheRead = numOr(usage['cacheReadTokens'], 0)
    const cacheWrite =
      numOr(usage['cacheWriteTokens'], 0) || numOr(usage['cacheCreationTokens'], 0)
    if (input + output + cacheRead + cacheWrite === 0) continue

    rows.push({
      agent: 'dsh',
      model: rowModel,
      input_tokens: input,
      output_tokens: output,
      cached_tokens: cacheRead + cacheWrite,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cost_usd: calcCost(rowModel, input, output, cacheRead, cacheWrite),
      at: numOr(e['time'], Date.now()),
      session_id: sessionId,
      meta: null,
      seq: typeof e['seq'] === 'number' ? e['seq'] : undefined
    })
  }
  return rows
}

/**
 * 解压 + 解析。压缩流损坏时 **抛错**（而不是返回空数组）：
 * 扫描器据此保留该文件已入库的行，避免「解析失败 → 按空重建 → 把历史行删光」。
 */
export function parseDshBuffer(raw: Uint8Array, fallbackSessionId: string): DshUsageRow[] {
  const text = new TextDecoder().decode(zstdDecompress(raw))
  return parseDshText(text, fallbackSessionId)
}

/** Worker 用：同步读盘（Worker 线程里阻塞无所谓） */
export function parseDshFile(filePath: string, fallbackSessionId: string): DshUsageRow[] {
  return parseDshBuffer(readFileSync(filePath), fallbackSessionId)
}

/** 主线程兜底用：异步读盘，解压仍同步 */
export async function parseDshFileAsync(
  filePath: string,
  fallbackSessionId: string
): Promise<DshUsageRow[]> {
  return parseDshBuffer(await readFile(filePath), fallbackSessionId)
}

/**
 * 会话内去重：v3 每个事件都有单调 seq，用 `${session}:${seq}`；
 * 缺 seq 的老格式退化为 `${session}:${at}`。
 */
export function dedupeDshRows(rows: DshUsageRow[]): DshUsageRow[] {
  const seen = new Set<string>()
  const out: DshUsageRow[] = []
  for (const r of rows) {
    const key = `${r.session_id}:${r.seq ?? `${r.at}:${r.model}:${r.input_tokens}:${r.output_tokens}`}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
