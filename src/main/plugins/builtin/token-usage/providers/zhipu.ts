/**
 * 智谱 AI Coding Plan（国内 bigmodel.cn）—— 端点与解析对齐 OpenChamber
 *  - GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *  - 响应同 z.ai：{ data: { limits: [TOKENS_LIMIT, TIME_LIMIT] } }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

interface ZhipuLimit {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number | string
}

function toTs(v: unknown): number | null {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

const adapter: ProviderAdapter = {
  id: 'zhipu',
  label: '智谱 AI Coding Plan (bigmodel.cn)',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson(
        'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
        { Authorization: `Bearer ${sub.credential}` }
      )) as Record<string, unknown> | null
      const payload = data?.data as Record<string, unknown> | undefined
      const limits = Array.isArray(payload?.limits)
        ? (payload.limits as ZhipuLimit[])
        : []
      if (limits.length === 0) {
        return { ok: false, error: '智谱响应无 limits 字段（检查 key 是否为 coding plan）' }
      }

      const windows: QuotaWindow[] = []
      // TOKENS_LIMIT = 5 小时 token 窗口
      const tokens = limits.find((l) => l.type === 'TOKENS_LIMIT')
      if (tokens) {
        windows.push({
          label: 'Tokens',
          usedPct:
            typeof tokens.percentage === 'number' ? tokens.percentage : null,
          resetAt: toTs(tokens.nextResetTime)
        })
      }
      // TIME_LIMIT = MCP 工具月度窗口
      const timeLimit = limits.find((l) => l.type === 'TIME_LIMIT')
      if (timeLimit) {
        windows.push({
          label: 'MCP Tools',
          usedPct:
            typeof timeLimit.percentage === 'number'
              ? timeLimit.percentage
              : null,
          resetAt: toTs(timeLimit.nextResetTime)
        })
      }
      if (windows.length === 0) {
        return { ok: false, error: '智谱响应未包含可用窗口' }
      }
      return {
        ok: true,
        snapshot: { windows, extra: { raw: data } }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查智谱 API key）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
