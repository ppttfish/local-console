/**
 * Provider 注册表 + UI 元信息序列化
 *  - providers：id → adapter
 *  - listProviderMetas()：给前端展示
 */
import type { ProviderAdapter } from './types.js'
import generic from './generic.js'
import anthropic from './anthropic.js'
import openai from './openai.js'
import MiniMax from './MiniMax.js'
import kimi from './kimi.js'
import zcode from './zcode.js'

export const providers: Record<string, ProviderAdapter> = {
  generic,
  anthropic,
  openai,
  MiniMax,
  kimi,
  zcode
}

export interface ProviderMeta {
  id: string
  label: string
  builtin: boolean
  defaultConfig: Record<string, unknown>
  configSchema: ProviderAdapter['configSchema']
  // 简单品牌色（用于卡片 logo 背景）
  color: string
  // 简写字母（用于 logo 文字）
  short: string
}

const META_EXTRAS: Record<string, { color: string; short: string }> = {
  generic: { color: '#64748b', short: 'G' },
  anthropic: { color: '#d97706', short: 'A' },
  openai: { color: '#10a37f', short: 'O' },
  MiniMax: { color: '#6366f1', short: 'M' },
  kimi: { color: '#1e293b', short: 'K' },
  zcode: { color: '#0ea5e9', short: 'Z' }
}

export function listProviderMetas(): ProviderMeta[] {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    builtin: p.builtin,
    defaultConfig: p.defaultConfig,
    configSchema: p.configSchema,
    color: META_EXTRAS[p.id]?.color ?? '#64748b',
    short: META_EXTRAS[p.id]?.short ?? p.id[0]?.toUpperCase() ?? '?'
  }))
}
