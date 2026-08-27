/**
 * MiniMax Coding Plan —— 端点与解析对齐 OpenChamber
 *  - 国际站: GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains （字段是已用量）
 *  - 国内站: GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains （字段是剩余量）
 *  - 响应: { base_resp: { status_code, status_msg }, model_remains: [{
 *      current_interval_total_count, current_interval_usage_count, start_time, end_time,
 *      current_weekly_total_count, current_weekly_usage_count, weekly_start_time, weekly_end_time }] }
 */
import { getJson } from '../http.js'
import type { ProviderAdapter, RefreshResult, QuotaWindow } from './types.js'
import type { Subscription } from '../subscriptions.js'

interface MiniMaxModelRemain {
  current_interval_total_count?: number
  current_interval_usage_count?: number
  start_time?: number
  end_time?: number
  current_weekly_total_count?: number
  current_weekly_usage_count?: number
  weekly_start_time?: number
  weekly_end_time?: number
}

function toTs(v: unknown): number | null {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  return null
}

function makeAdapter(
  id: 'minimax-io' | 'minimax-cn',
  label: string,
  endpoint: string,
  fieldsAreRemaining: boolean
): ProviderAdapter {
  return {
    id,
    label,
    builtin: true,
    defaultConfig: {},
    configSchema: [],
    async fetch(sub: Subscription): Promise<RefreshResult> {
      try {
        const data = (await getJson(endpoint, {
          Authorization: `Bearer ${sub.credential}`
        })) as Record<string, unknown> | null

        const baseResp = data?.base_resp as Record<string, unknown> | undefined
        const statusCode =
          typeof baseResp?.status_code === 'number'
            ? baseResp.status_code
            : null
        if (baseResp && statusCode !== 0) {
          const m =
            typeof baseResp.status_msg === 'string'
              ? baseResp.status_msg
              : `API error ${statusCode}`
          return { ok: false, error: `MiniMax: ${m}` }
        }

        const remains = Array.isArray(data?.model_remains)
          ? (data.model_remains as MiniMaxModelRemain[])
          : []
        const first = remains[0]
        if (!first) {
          return { ok: false, error: 'MiniMax 响应无 model_remains' }
        }

        // 国内站 usage 字段语义是"剩余"，需翻转
        const flip = (usage: number | undefined, total: number | undefined) => {
          if (
            fieldsAreRemaining &&
            typeof total === 'number' &&
            typeof usage === 'number'
          ) {
            return total - usage
          }
          return typeof usage === 'number' ? usage : null
        }

        const windows: QuotaWindow[] = []
        const iTotal = first.current_interval_total_count
        const iUsed = flip(first.current_interval_usage_count, iTotal)
        if (typeof iTotal === 'number' && iTotal > 0 && iUsed !== null) {
          windows.push({
            label: '5h',
            usedPct: Math.max(0, Math.min(100, (iUsed / iTotal) * 100)),
            resetAt: toTs(first.end_time)
          })
        }
        const wTotal = first.current_weekly_total_count
        const wUsed = flip(first.current_weekly_usage_count, wTotal)
        if (typeof wTotal === 'number' && wTotal > 0 && wUsed !== null) {
          windows.push({
            label: 'weekly',
            usedPct: Math.max(0, Math.min(100, (wUsed / wTotal) * 100)),
            resetAt: toTs(first.weekly_end_time)
          })
        }
        if (windows.length === 0) {
          return { ok: false, error: 'MiniMax 响应未包含可用窗口' }
        }
        return { ok: true, snapshot: { windows, extra: { raw: data } } }
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('401') || msg.includes('403')) {
          return { ok: false, error: '鉴权失败（检查 MiniMax API key）' }
        }
        return { ok: false, error: msg.includes('超时') ? '请求超时' : msg }
      }
    }
  }
}

export const minimaxIo = makeAdapter(
  'minimax-io',
  'MiniMax Coding Plan (minimax.io)',
  'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  false
)

export const minimaxCn = makeAdapter(
  'minimax-cn',
  'MiniMax Coding Plan (minimaxi.com)',
  'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  true
)
