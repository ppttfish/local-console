/**
 * Anthropic Provider —— Claude Pro / Max / Team / Enterprise
 *  - 调 https://api.anthropic.com/v1/organizations/usage
 *  - 响应包含 five_hour / seven_day / seven_day_opus 三个窗口的 utilization
 *  - v1 默认拿 seven_day（与 plan 关联最紧密）；config.plan_tier 可切到 "five_hour" 或 "seven_day_opus"
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

const provider: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  builtin: true,
  defaultConfig: { plan_tier: 'seven_day' },
  configSchema: [
    {
      key: 'plan_tier',
      label: '监控窗口',
      type: 'select',
      required: true,
      options: ['five_hour', 'seven_day', 'seven_day_opus'],
      hint: 'five_hour = 5h 滚动；seven_day = 周配额；seven_day_opus = Opus 单独周配额'
    }
  ],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    const tier = (sub.config.plan_tier as string) || 'seven_day'
    try {
      const data = (await getJson(
        'https://api.anthropic.com/v1/organizations/usage',
        {
          'x-api-key': sub.credential,
          'anthropic-version': '2023-06-01'
        }
      )) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'Anthropic 响应为空' }
      }
      const block = data[tier] as Record<string, unknown> | undefined
      if (!block || typeof block !== 'object') {
        return {
          ok: false,
          error: `Anthropic 响应缺 ${tier} 字段（响应可能 schema 变化）`
        }
      }
      const utilization = Number(block.utilization ?? 0)
      const resetsAt = typeof block.resets_at === 'string' ? block.resets_at : null
      const windowEnd = resetsAt ? Date.parse(resetsAt) : undefined
      // Anthropic 给的是百分比；limit 不可知 → 用 1.0 作分母，used = utilization / 100
      const limit = 1
      const used = utilization / 100
      return {
        ok: true,
        snapshot: {
          used,
          limit,
          remaining: Math.max(0, 1 - used),
          usedPct: Math.min(100, utilization),
          windowEnd:
            windowEnd && !Number.isNaN(windowEnd) ? windowEnd : undefined,
          extra: { raw: data, tier }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 API key / 是否为 admin）' }
      }
      if (msg.includes('超时')) {
        return { ok: false, error: '请求超时' }
      }
      return { ok: false, error: msg }
    }
  }
}

export default provider
