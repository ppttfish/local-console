/**
 * Kimi for Coding (Moonshot) —— 端点与解析对齐 OpenChamber
 *  - GET https://api.kimi.com/coding/v1/usages
 *  - 响应: { usage: { limit, used, remaining, resetTime }, limits: [{ window: {duration,timeUnit}, detail: {limit,used,remaining,resetTime} }] }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

function toTs(v: unknown): number | null {
  if (!v) return null
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function toNum(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function durationToLabel(d?: number, unit?: string): string {
  if (!d || !unit) return 'limit'
  if (unit === 'TIME_UNIT_MINUTE') return `${d}m`
  if (unit === 'TIME_UNIT_HOUR') return `${d}h`
  if (unit === 'TIME_UNIT_DAY') return `${d}d`
  return 'limit'
}

function durationToSeconds(d?: number, unit?: string): number | null {
  if (!d || !unit) return null
  if (unit === 'TIME_UNIT_MINUTE') return d * 60
  if (unit === 'TIME_UNIT_HOUR') return d * 3600
  if (unit === 'TIME_UNIT_DAY') return d * 86400
  return null
}

/** usedPct：优先 used/limit；缺失时用 remaining 反推 */
function pct(limit: number | null, used: number | null, remaining: number | null): number | null {
  if (limit !== null && limit > 0 && used !== null) {
    return Math.max(0, Math.min(100, (used / limit) * 100))
  }
  if (remaining !== null && limit !== null && limit > 0) {
    return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100))
  }
  return null
}

const adapter: ProviderAdapter = {
  id: 'kimi',
  label: 'Kimi for Coding',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson('https://api.kimi.com/coding/v1/usages', {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null

      const windows: QuotaWindow[] = []
      const usage = data?.usage as Record<string, unknown> | undefined
      if (usage) {
        windows.push({
          label: 'weekly',
          usedPct: pct(
            toNum(usage.limit),
            toNum(usage.used),
            toNum(usage.remaining)
          ),
          resetAt: toTs(usage.resetTime)
        })
      }

      const limits = Array.isArray(data?.limits)
        ? (data!.limits as Array<Record<string, unknown>>)
        : []
      for (const l of limits) {
        const win = l.window as Record<string, unknown> | undefined
        const detail = l.detail as Record<string, unknown> | undefined
        const secs = durationToSeconds(
          toNum(win?.duration) ?? undefined,
          typeof win?.timeUnit === 'string' ? win.timeUnit : undefined
        )
        const raw = durationToLabel(
          toNum(win?.duration) ?? undefined,
          typeof win?.timeUnit === 'string' ? win.timeUnit : undefined
        )
        windows.push({
          label: secs === 5 * 3600 ? `Rate Limit (${raw})` : raw,
          usedPct: pct(
            toNum(detail?.limit),
            toNum(detail?.used),
            toNum(detail?.remaining)
          ),
          resetAt: toTs(detail?.resetTime)
        })
      }

      if (windows.length === 0) {
        return { ok: false, error: 'Kimi 响应未包含可用窗口' }
      }
      return { ok: true, snapshot: { windows, extra: { raw: data } } }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 Kimi API key）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
