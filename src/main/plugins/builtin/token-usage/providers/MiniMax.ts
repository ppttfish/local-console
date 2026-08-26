/**
 * MiniMax Provider —— Token Plan
 *  - 调 https://api.MiniMax.chat/v1/token_plan/usage
 *  - 响应 schema 跟 OpenChamber 一起在演进，v1 兼容:
 *      { usage, limit, reset_at }  OR  { data: { usage, limit, reset_at } }
 *      OR  { usage_tokens, total_tokens, next_reset_at }
 *  - 解析失败时把 raw 写到 extra，UI 显示「原始响应」
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

const provider: ProviderAdapter = {
  id: 'MiniMax',
  label: 'MiniMax (Token Plan)',
  builtin: true,
  defaultConfig: { base_url: 'https://api.MiniMax.chat' },
  configSchema: [
    {
      key: 'base_url',
      label: 'API 根地址',
      type: 'text',
      required: false,
      placeholder: 'https://api.MiniMax.chat',
      hint: '国内/全球站可能不同；留空用默认值'
    }
  ],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    const baseUrl =
      (sub.config.base_url as string) || 'https://api.MiniMax.chat'
    const url = `${baseUrl.replace(/\/$/, '')}/v1/token_plan/usage`
    try {
      const data = (await getJson(url, {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'MiniMax 响应为空' }
      }
      // 兼容嵌套 { data: {...} }
      const inner = (data.data as Record<string, unknown> | undefined) ?? data
      const used = Number(pick(inner, ['usage', 'usage_tokens', 'used']) ?? 0)
      const limit = Number(
        pick(inner, ['limit', 'total_tokens', 'quota']) ?? 0
      )
      const resetRaw = pick(inner, ['reset_at', 'next_reset_at', 'resetAt'])
      let windowEnd: number | undefined
      if (typeof resetRaw === 'number') windowEnd = resetRaw
      else if (typeof resetRaw === 'string') {
        const t = Date.parse(resetRaw)
        if (!Number.isNaN(t)) windowEnd = t
      }
      if (limit <= 0) {
        return {
          ok: false,
          error:
            'MiniMax 响应未找到 limit 字段（可能 schema 变化；已附原始响应）'
        }
      }
      const usedPct = Math.min(100, (used / limit) * 100)
      return {
        ok: true,
        snapshot: {
          used,
          limit,
          remaining: Math.max(0, limit - used),
          usedPct,
          windowEnd,
          extra: { raw: data }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 MiniMax API key）' }
      }
      if (msg.includes('超时')) {
        return { ok: false, error: '请求超时' }
      }
      return { ok: false, error: msg }
    }
  }
}

export default provider
