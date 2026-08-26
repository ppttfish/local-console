/**
 * Provider 注册表 + UI 元信息序列化
 *  - providers：id → adapter（端点全部对齐 OpenChamber 实现）
 *  - listProviderMetas()：给前端展示
 */
import type { ProviderAdapter } from './types.js'
import generic from './generic.js'
import anthropic from './anthropic.js'
import openai from './openai.js'
import { minimaxIo, minimaxCn } from './MiniMax.js'
import kimi from './kimi.js'
import zai from './zai.js'
import zhipu from './zhipu.js'
import openrouter from './openrouter.js'
import opencodeGo from './opencodeGo.js'
import commandCode from './commandCode.js'

export const providers: Record<string, ProviderAdapter> = {
  generic,
  anthropic,
  openai,
  zai,
  zhipu,
  'minimax-io': minimaxIo,
  'minimax-cn': minimaxCn,
  kimi,
  openrouter,
  'opencode-go': opencodeGo,
  'command-code': commandCode
}

export interface ProviderMeta {
  id: string
  label: string
  builtin: boolean
  defaultConfig: Record<string, unknown>
  configSchema: ProviderAdapter['configSchema']
  color: string
  short: string
}

const META_EXTRAS: Record<string, { color: string; short: string }> = {
  generic: { color: '#64748b', short: 'G' },
  anthropic: { color: '#d97706', short: 'A' },
  openai: { color: '#10a37f', short: 'O' },
  zai: { color: '#6366f1', short: 'Z' },
  zhipu: { color: '#38bdf8', short: '智' },
  'minimax-io': { color: '#f43f5e', short: 'M' },
  'minimax-cn': { color: '#fb7185', short: 'M' },
  kimi: { color: '#1e293b', short: 'K' },
  openrouter: { color: '#8b5cf6', short: 'R' },
  'opencode-go': { color: '#0ea5e9', short: 'G' },
  'command-code': { color: '#22c55e', short: 'C' }
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
