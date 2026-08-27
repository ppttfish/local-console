/**
 * Command Code (commandcode.ai) —— 端点与解析对齐 OpenChamber
 *  - GET https://api.commandcode.ai/alpha/whoami            → { org: { id } }
 *  - GET https://api.commandcode.ai/alpha/billing/credits?orgId=...
 *    → { credits: { monthlyCredits, purchasedCredits, freeCredits },
 *        windowLimits: { fiveHour: {used, cap, resetAt}, weekly: {...} } }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

interface CommandCodeLimits {
  fiveHour?: { used?: number; cap?: number; resetAt?: number }
  weekly?: { used?: number; cap?: number; resetAt?: number }
}

interface CommandCodeCredits {
  monthlyCredits?: number
  purchasedCredits?: number
  freeCredits?: number
}

interface CommandCodePayload {
  credits?: CommandCodeCredits
  windowLimits?: CommandCodeLimits
}

const adapter: ProviderAdapter = {
  id: 'command-code',
  label: 'Command Code',
  builtin: true,
  defaultConfig: {},
  configSchema: [],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    try {
      // 1) whoami → orgId（有些账户没有 org 字段则不带 orgId 也能拉）
      let orgId: string | null = null
      try {
        const me = (await getJson('https://api.commandcode.ai/alpha/whoami', {
          Authorization: `Bearer ${sub.credential}`
        })) as Record<string, unknown> | null
        const org = me?.org as { id?: string } | undefined
        if (org && typeof org.id === 'string' && org.id.trim()) {
          orgId = org.id.trim()
        }
      } catch {
        // 忽略：org 取不到时直接拉公共 credits 端点
      }

      // 2) credits
      const path = orgId
        ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`
        : '/alpha/billing/credits'
      const data = (await getJson(`https://api.commandcode.ai${path}`, {
        Authorization: `Bearer ${sub.credential}`
      })) as CommandCodePayload | null
      if (!data) return { ok: false, error: 'Command Code 响应为空' }

      const windows: QuotaWindow[] = []

      // 余额类（无百分比）
      for (const [label, v] of [
        ['monthly credits', data.credits?.monthlyCredits],
        ['purchased credits', data.credits?.purchasedCredits],
        ['free credits', data.credits?.freeCredits]
      ] as const) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          windows.push({
            label,
            usedPct: null,
            resetAt: null,
            valueLabel: String(Math.round((v + Number.EPSILON) * 100) / 100)
          })
        }
      }

      // 窗口限额
      const isFin = (x: unknown): x is number =>
        typeof x === 'number' && Number.isFinite(x)
      for (const [label, lim, seconds] of [
        ['5h', data.windowLimits?.fiveHour, 5 * 60 * 60],
        ['weekly', data.windowLimits?.weekly, 7 * 24 * 60 * 60]
      ] as const) {
        if (
          lim &&
          isFin(lim.used) &&
          isFin(lim.cap) &&
          (lim.cap as number) > 0
        ) {
          const cap = lim.cap as number
          const used = lim.used as number
          const resetAt = isFin(lim.resetAt)
            ? (lim.resetAt < 1e12 ? (lim.resetAt as number) * 1000 : lim.resetAt)
            : null
          windows.push({
            label,
            usedPct: Math.max(0, Math.min(100, (used / cap) * 100)),
            resetAt,
            valueLabel: `${Math.round(used * 100) / 100} / ${Math.round(cap * 100) / 100}`
          })
        }
      }

      if (windows.length === 0) {
        return { ok: false, error: 'Command Code 响应未包含可用窗口' }
      }
      return { ok: true, snapshot: { windows, extra: { raw: data } } }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 Command Code API key）' }
      }
      return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
    }
  }
}

export default adapter
