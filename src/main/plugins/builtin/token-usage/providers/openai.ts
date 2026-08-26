/**
 * OpenAI Provider —— Credit Grants / Subscription
 *  - 调 https://api.openai.com/v1/dashboard/billing/credit_grants
 *  - 响应: { total_granted, total_used, total_available, ... }
 *  - 30 天滚动窗口（OpenAI 月结）
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

const provider: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson(
        'https://api.openai.com/v1/dashboard/billing/credit_grants',
        { Authorization: `Bearer ${sub.credential}` }
      )) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'OpenAI 响应为空' }
      }
      const totalGranted = Number(data.total_granted ?? 0)
      const totalUsed = Number(data.total_used ?? 0)
      const totalAvailable = Number(
        data.total_available ?? totalGranted - totalUsed
      )
      if (totalGranted <= 0) {
        return { ok: false, error: 'OpenAI 返回 total_granted = 0' }
      }
      // 30 天滚动窗口
      const now = Date.now()
      const windowStart = now - 30 * 24 * 3600 * 1000
      const windowEnd = now + 30 * 24 * 3600 * 1000
      const usedPct = Math.min(100, (totalUsed / totalGranted) * 100)
      return {
        ok: true,
        snapshot: {
          used: totalUsed,
          limit: totalGranted,
          remaining: totalAvailable,
          usedPct,
          windowStart,
          windowEnd,
          currency: 'USD',
          extra: { raw: data }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 OpenAI API key）' }
      }
      if (msg.includes('超时')) {
        return { ok: false, error: '请求超时' }
      }
      return { ok: false, error: msg }
    }
  }
}

export default provider
