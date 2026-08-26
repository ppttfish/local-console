/**
 * OpenCode Go —— 端点与解析对齐 OpenChamber
 *  - GET https://opencode.ai/zen/go/v1/usage
 *  - 响应: { usage: { rolling: {percent, resetsAt}, weekly: {...}, monthly: {...} } }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

interface GoWindowEntry {
  percent?: unknown
  resetsAt?: unknown
}

const adapter: ProviderAdapter = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      const data = (await getJson('https://opencode.ai/zen/go/v1/usage', {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null
      const usage = data?.usage as Record<string, GoWindowEntry> | undefined

      const windows: QuotaWindow[] = []
      const pick = (
        label: string,
        entry: GoWindowEntry | undefined
      ): void => {
        if (!entry) return
        const pct = Number(entry.percent)
        const reset = typeof entry.resetsAt === 'string' ? Date.parse(entry.resetsAt) : NaN
        if (!Number.isFinite(pct)) return
        windows.push({
          label,
          usedPct: Math.max(0, Math.min(100, pct)),
          resetAt: Number.isFinite(reset) ? reset : null
        })
      }
      // rolling → 5h；weekly/monthly 同名
      pick('5h', usage?.rolling)
      pick('weekly', usage?.weekly)
      pick('monthly', usage?.monthly)

      if (windows.length === 0) {
        return { ok: false, error: 'OpenCode Go 响应无法解析出窗口数据' }
      }
      return { ok: true, snapshot: { windows, extra: { raw: data } } }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 OpenCode Go 凭证）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
