/**
 * Z.AI Provider —— ZCode 配额
 *  - 调 https://api.z.ai/api/quotas
 *  - 响应: { data: [{ plan_id, used, limit, reset_at, ... }, ...] } 或 { quotas: [...] }
 *  - config.plan_id 指定要监控哪个 plan；不指定默认取第一条
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult } from './types.js'
import type { Subscription } from '../subscriptions.js'

const provider: ProviderAdapter = {
  id: 'zcode',
  label: 'Z.AI (ZCode)',
  builtin: true,
  defaultConfig: { base_url: 'https://api.z.ai' },
  configSchema: [
    {
      key: 'base_url',
      label: 'API 根地址',
      type: 'text',
      required: false,
      placeholder: 'https://api.z.ai',
      hint: '国内默认 api.z.ai；海外用户可换 api.z.ai/global'
    },
    {
      key: 'plan_id',
      label: 'Plan ID（可选）',
      type: 'text',
      required: false,
      placeholder: 'pro / max / ...',
      hint: '留空则取第一条'
    }
  ],
  async fetch(sub: Subscription): Promise<RefreshResult> {
    const baseUrl = (sub.config.base_url as string) || 'https://api.z.ai'
    const planId = (sub.config.plan_id as string) || ''
    const url = `${baseUrl.replace(/\/$/, '')}/api/quotas`
    try {
      const data = (await getJson(url, {
        Authorization: `Bearer ${sub.credential}`
      })) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'Z.AI 响应为空' }
      }
      const list = (data.data as unknown[]) ?? (data.quotas as unknown[]) ?? []
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, error: 'Z.AI 响应未找到 quota 数组' }
      }
      const block =
        (planId
          ? (list as Record<string, unknown>[]).find(
              (q) => (q.plan_id as string) === planId
            )
          : (list[0] as Record<string, unknown>)) ?? (list[0] as Record<string, unknown>)
      const used = Number(block.used ?? 0)
      const limit = Number(block.limit ?? 0)
      const resetRaw = block.reset_at
      let windowEnd: number | undefined
      if (typeof resetRaw === 'number') windowEnd = resetRaw
      else if (typeof resetRaw === 'string') {
        const t = Date.parse(resetRaw)
        if (!Number.isNaN(t)) windowEnd = t
      }
      if (limit <= 0) {
        return {
          ok: false,
          error: 'Z.AI 响应未找到 limit（可能 schema 变化）'
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
          windowEnd,
          extra: { raw: block, plan_id: block.plan_id }
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('401') || msg.includes('403')) {
        return { ok: false, error: '鉴权失败（检查 Z.AI API key）' }
      }
      if (msg.includes('超时')) {
        return { ok: false, error: '请求超时' }
      }
      return { ok: false, error: msg }
    }
  }
}

export default provider
