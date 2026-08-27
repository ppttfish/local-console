/**
 * 回顾页成就系统 —— 规则全部从 UsageRecap 聚合派生，无额外数据需求。
 * reached() 判定点亮；progress() 给未达成的进度提示；value() 给达成后的展示文案。
 */
import type { UsageRecap } from '@shared/types'
import { fmtToken, fmtCost, fmtDate } from './format'

export interface Achievement {
  id: string
  icon: string
  name: string
  hint: string
  reached: (r: UsageRecap) => boolean
  value: (r: UsageRecap) => string
  progress: (r: UsageRecap) => { text: string; ratio: number } | null
}

const NIGHT_HOURS = [0, 1, 2, 3, 4, 5]

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first-record',
    icon: '🎂',
    name: '初见之日',
    hint: '第一次留下调用记录',
    reached: (r) => r.first_at != null,
    value: (r) => fmtDate(r.first_at),
    progress: () => null
  },
  {
    id: 'million-club',
    icon: '🏆',
    name: '百万俱乐部',
    hint: '累计 Token 突破 100 万',
    reached: (r) => r.totals.total_tokens >= 1_000_000,
    value: (r) => fmtToken(r.totals.total_tokens) + ' tokens',
    progress: (r) => ({
      text: `${fmtToken(r.totals.total_tokens)} / 100万`,
      ratio: clamp01(r.totals.total_tokens / 1_000_000)
    })
  },
  {
    id: 'ten-million-squad',
    icon: '🚀',
    name: '千万战队',
    hint: '累计 Token 突破 1000 万',
    reached: (r) => r.totals.total_tokens >= 10_000_000,
    value: (r) => fmtToken(r.totals.total_tokens) + ' tokens',
    progress: (r) => ({
      text: `${fmtToken(r.totals.total_tokens)} / 1000万`,
      ratio: clamp01(r.totals.total_tokens / 10_000_000)
    })
  },
  {
    id: 'big-spender',
    icon: '💰',
    name: '氪金玩家',
    hint: '累计成本突破 $100',
    reached: (r) => r.totals.cost_usd >= 100,
    value: (r) => fmtCost(r.totals.cost_usd),
    progress: (r) => ({
      text: `${fmtCost(r.totals.cost_usd)} / $100.00`,
      ratio: clamp01(r.totals.cost_usd / 100)
    })
  },
  {
    id: 'loyal-model',
    icon: '❤️',
    name: '本命不渝',
    hint: '单一模型用量占比 ≥ 60%',
    reached: (r) => (r.top_model?.share ?? 0) >= 60,
    value: (r) =>
      r.top_model ? `${r.top_model.model} · ${r.top_model.share.toFixed(1)}%` : '—',
    progress: (r) =>
      r.top_model
        ? {
            text: `当前 ${r.top_model.share.toFixed(1)}% / 60%`,
            ratio: clamp01(r.top_model.share / 60)
          }
        : null
  },
  {
    id: 'cache-master',
    icon: '⚡',
    name: '缓存大师',
    hint: '整体缓存命中率 ≥ 60%',
    reached: (r) => r.totals.cache_hit_ratio >= 60,
    value: (r) => `${r.totals.cache_hit_ratio.toFixed(1)}%`,
    progress: (r) => ({
      text: `当前 ${r.totals.cache_hit_ratio.toFixed(1)}% / 60%`,
      ratio: clamp01(r.totals.cache_hit_ratio / 60)
    })
  },
  {
    id: 'week-streak',
    icon: '📅',
    name: '七日之约',
    hint: '连续 7 天都有用量',
    reached: (r) => r.best_streak >= 7,
    value: (r) => `最长连续 ${r.best_streak} 天`,
    progress: (r) => ({
      text: `最长 ${r.best_streak} / 7 天`,
      ratio: clamp01(r.best_streak / 7)
    })
  },
  {
    id: 'around-clock',
    icon: '🌍',
    name: '全天候战士',
    hint: '24 个小时段都留下过调用',
    reached: (r) => r.hour_histogram.every((n) => n > 0),
    value: () => '24 小时全勤',
    progress: (r) => {
      const covered = r.hour_histogram.filter((n) => n > 0).length
      return { text: `${covered} / 24 个时段`, ratio: clamp01(covered / 24) }
    }
  },
  {
    id: 'night-owl',
    icon: '🦉',
    name: '夜行侠',
    hint: '凌晨 0-5 点调用占比 ≥ 30%',
    reached: (r) => {
      const total = r.hour_histogram.reduce((a, b) => a + b, 0)
      if (total === 0) return false
      const night = NIGHT_HOURS.reduce((a, h) => a + r.hour_histogram[h]!, 0)
      return night / total >= 0.3
    },
    value: (r) => {
      const total = r.hour_histogram.reduce((a, b) => a + b, 0)
      const night = NIGHT_HOURS.reduce((a, h) => a + r.hour_histogram[h]!, 0)
      return total === 0 ? '—' : `${((night / total) * 100).toFixed(1)}% 在深夜`
    },
    progress: (r) => {
      const total = r.hour_histogram.reduce((a, b) => a + b, 0)
      const night = NIGHT_HOURS.reduce((a, h) => a + r.hour_histogram[h]!, 0)
      const pct = total === 0 ? 0 : (night / total) * 100
      return {
        text: `当前 ${pct.toFixed(1)}% / 30%`,
        ratio: clamp01(pct / 30)
      }
    }
  },
  {
    id: 'polyglot-day',
    icon: '🐙',
    name: '多栖动物',
    hint: '同一天用满 3 个平台',
    reached: (r) => Math.max(0, ...r.days.map((d) => d.agents)) >= 3,
    value: (r) => `单日最多 ${Math.max(0, ...r.days.map((d) => d.agents))} 个平台`,
    progress: (r) => {
      const max = Math.max(0, ...r.days.map((d) => d.agents))
      return { text: `单日最多 ${max} / 3 个平台`, ratio: clamp01(max / 3) }
    }
  }
]

/** 作息人格一句话 */
export function personaLine(recap: UsageRecap): string {
  const h = recap.hour_histogram
  const total = h.reduce((a, b) => a + b, 0)
  if (total === 0) return '还没有任何调用记录'
  const sum = (from: number, to: number) =>
    h.slice(from, to + 1).reduce((a, b) => a + b, 0)
  const night = sum(0, 5) / total
  const morning = sum(6, 11) / total
  const daytime = sum(9, 18) / total
  if (night >= 0.3) return '夜猫子型选手 —— 深夜的 token 最香'
  if (morning >= 0.4) return '早起鸟型选手 —— 一日之计在于晨'
  if (daytime >= 0.5) return '工作日战士 —— 主业打得火热'
  if (h.every((n) => n > 0)) return '全天候战士 —— 时区概念对你无效'
  return '均衡型选手 —— 张弛有度'
}
