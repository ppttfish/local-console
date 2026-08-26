/**
 * Kimi Provider —— Moonshot AI
 *  - 调 https://api.moonshot.cn/v1/users/me/usage
 *  - 响应: { used_tokens, total_tokens, reset_date (ISO8601) }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

const provider: ProviderAdapter = {
  id: 'kimi',
  label: 'Kimi (Moonshot)',
  builtin: true,
  defaultConfig: { base_url: 'https://api.moonshot.cn' },
  configSchema: [
    {
      key: 'base_url',
      label: 'API 根地址',
      type: 'text',
      required: false,
      placeholder: 'https://api.moonshot.cn',
      hint: '海外用户可换 platform-api.moonshot.ai'
    }
  ],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    const baseUrl =
      (sub.config.base_url as string) || 'https://api.moonshot.cn'
    const url = `${baseUrl.replace(/\/$/, '')}/v1/users/me/usage`
    try {
      const data = (await getJson(url, {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'Kimi 响应为空' }
      }
      const used = Number(data.used_tokens ?? 0)
      const limit = Number(data.total_tokens ?? 0)
      const resetDate =
        typeof data.reset_date === 'string' ? data.reset_date : null
      const windowEnd = resetDate ? Date.parse(resetDate) : undefined
      if (limit <= 0) {
        return {
          ok: false,
          error: 'Kimi 响应未找到 total_tokens（可能 schema 变化）'
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
          windowEnd: windowEnd && !Number.isNaN(windowEnd) ? windowEnd : undefined,
          extra: { raw: data }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 Kimi API key）' }
      }
      if (msg.includes('超时')) {
        return { ok: false, error: '请求超时' }
      }
      return { ok: false, error: msg }
    }
  }
}

export default provider
