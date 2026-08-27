/**
 * OpenRouter —— 端点对齐 OpenChamber
 *  - GET https://openrouter.ai/api/v1/credits
 *  - 响应: { data: { total_credits, total_usage } } → credits 窗口
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

const adapter: ProviderAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson('https://openrouter.ai/api/v1/credits', {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null
      const credits = data?.data as Record<string, unknown> | undefined
      const total = Number(credits?.total_credits ?? 0)
      const used = Number(credits?.total_usage ?? 0)
      if (!(total > 0)) {
        return { ok: false, error: 'OpenRouter 返回 total_credits = 0' }
      }
      const windows: QuotaWindow[] = [
        {
          label: 'credits',
          usedPct: Math.min(100, (used / total) * 100),
          resetAt: null,
          valueLabel: `$${used.toFixed(2)} / $${total.toFixed(2)}`
        }
      ]
      return {
        ok: true,
        snapshot: { windows, currency: 'USD', extra: { raw: data } }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 OpenRouter API key）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
