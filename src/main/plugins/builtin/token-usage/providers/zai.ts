/**
 * z.ai Coding Plan（智谱海外 / Z.AI）—— 端点与解析对齐 OpenChamber
 *  - GET https://api.z.ai/api/monitor/usage/quota/limit
 *  - 响应: { code, data: { level, limits: [...] } }
 *    - TOKENS_LIMIT/CREDIT_LIMIT: { unit, number, percentage, nextResetTime }
 *      unit→秒映射（OC 源码）: 3 = 3600s, 6 = 7d；windowSeconds = unitSeconds × number
 *    - TIME_LIMIT (unit=5 → 月): MCP Tools 窗口
 */
import { getJson } from '../http.js'
import type {
  ProviderAdapter,
  RefreshResult,
  QuotaWindow
} from './types.js'
import type { Subscription } from '../subscriptions.js'

const UNIT_SECONDS: Record<number, number> = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60
}

function windowLabel(seconds: number | null): string {
  if (!seconds) return 'tokens'
  if (seconds % 86400 === 0) {
    const days = seconds / 86400
    return days === 7 ? 'weekly' : `${days}d`
  }
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${seconds}s`
}

interface ZaiLimit {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
}

const adapter: ProviderAdapter = {
  id: 'zai',
  label: 'z.ai Coding Plan',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson(
        'https://api.z.ai/api/monitor/usage/quota/limit',
        { Authorization: `Bearer ${sub.credential}` }
      )) as Record<string, unknown> | null
      const payload = data?.data as Record<string, unknown> | undefined
      const limits = Array.isArray(payload?.limits)
        ? (payload.limits as ZaiLimit[])
        : []
      if (limits.length === 0) {
        return { ok: false, error: 'z.ai 响应无 limits 字段' }
      }

      const windows: QuotaWindow[] = []
      for (const l of limits) {
        if (l.type !== 'TOKENS_LIMIT' && l.type !== 'CREDIT_LIMIT') continue
        const unitSeconds =
          typeof l.unit === 'number' ? UNIT_SECONDS[l.unit] : undefined
        const windowSeconds =
          unitSeconds && typeof l.number === 'number'
            ? unitSeconds * l.number
            : null
        windows.push({
          label: windowLabel(windowSeconds),
          usedPct:
            typeof l.percentage === 'number' ? l.percentage : null,
          resetAt:
            typeof l.nextResetTime === 'number'
              ? l.nextResetTime < 1e12
                ? l.nextResetTime * 1000
                : l.nextResetTime
              : null
        })
      }
      const mcp = limits.find((l) => l.type === 'TIME_LIMIT')
      if (mcp) {
        windows.push({
          label: 'MCP Tools',
          usedPct: typeof mcp.percentage === 'number' ? mcp.percentage : null,
          // TIME_LIMIT 与上面窗口同源，秒级时间戳同样需要换算成毫秒，
          // 否则倒计时会按 1970 年计算而出错
          resetAt:
            typeof mcp.nextResetTime === 'number'
              ? mcp.nextResetTime < 1e12
                ? mcp.nextResetTime * 1000
                : mcp.nextResetTime
              : null
        })
      }
      if (windows.length === 0) {
        return { ok: false, error: 'z.ai 响应未包含可用窗口' }
      }
      return {
        ok: true,
        snapshot: {
          planLabel:
            typeof payload?.level === 'string' ? payload.level : null,
          windows,
          extra: { raw: data }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 z.ai API key）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
