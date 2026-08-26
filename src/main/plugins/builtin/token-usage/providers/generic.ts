/**
 * generic Provider —— 通用兜底
 *  - 不调网络；直接读 sub.config 里的 { used, limit, reset_at }
 *  - 任意服务商都能用：用户手动维护"已用/总量/重置时间"
 */
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

const provider: ProviderAdapter = {
  id: 'generic',
  label: '通用（手动维护）',
  builtin: false,
  defaultConfig: { used: 0, limit: 0, reset_at: 0 },
  configSchema: [
    {
      key: 'used',
      label: '已用（tokens）',
      type: 'number',
      required: true,
      placeholder: '4000000',
      hint: '当前周期已消耗的 tokens'
    },
    {
      key: 'limit',
      label: '总额（tokens）',
      type: 'number',
      required: true,
      placeholder: '10000000',
      hint: '当前周期总额度'
    },
    {
      key: 'reset_at',
      label: '重置时间（毫秒时间戳）',
      type: 'number',
      required: true,
      placeholder: '1735660800000',
      hint: '下次重置的时刻'
    }
  ],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    const used = Number(sub.config.used ?? 0)
    const limit = Number(sub.config.limit ?? 0)
    const resetRaw = sub.config.reset_at
    const resetAt = typeof resetRaw === 'number' ? resetRaw : Number(resetRaw ?? 0)
    if (limit <= 0) {
      return { ok: false, error: 'limit 必须大于 0' }
    }
    const remaining = Math.max(0, limit - used)
    const usedPct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
    return {
      ok: true,
      snapshot: {
        used,
        limit,
        remaining,
        usedPct,
        windowEnd: resetAt > 0 ? resetAt : undefined
      }
    }
  }
}

export default provider
