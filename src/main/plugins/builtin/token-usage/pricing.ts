/**
 * 模型定价 —— 美元 / 1M tokens
 * 跟 ccswitch 的 model-pricing.json 思路一致：维护一个静态表
 * 用户可在 UI 里改后写到磁盘
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface ModelPrice {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export type PricingTable = Record<string, ModelPrice>

// 默认定价（USD / 1M tokens，公开价格；2026 年初）
const DEFAULT: PricingTable = {
  // OpenAI / Codex
  'gpt-4o': { input: 2.5, output: 10, cache_read: 1.25, cache_write: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 },
  'gpt-5': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  'gpt-5.4': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  'gpt-5.5': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  'gpt-5.6': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  'gpt-5.6-terra': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  'gpt-5.3-codex': { input: 5, output: 20, cache_read: 2.5, cache_write: 0 },
  o1: { input: 15, output: 60, cache_read: 7.5, cache_write: 0 },
  o1_mini: { input: 3, output: 12, cache_read: 1.5, cache_write: 0 },
  o3: { input: 10, output: 40, cache_read: 5, cache_write: 0 },
  o3_mini: { input: 1.1, output: 4.4, cache_read: 0.55, cache_write: 0 },
  o4_mini: { input: 1.1, output: 4.4, cache_read: 0.55, cache_write: 0 },

  // Anthropic
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-7': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4': { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  'claude-3-5-sonnet': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  'claude-3-opus': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },

  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.31, cache_write: 0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cache_read: 0.075, cache_write: 0 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cache_read: 0.025, cache_write: 0 },

  // xAI
  'grok-4': { input: 3, output: 15, cache_read: 0.75, cache_write: 0 },
  'grok-4.5': { input: 3, output: 15, cache_read: 0.75, cache_write: 0 },
  'grok-4.5-build-free': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  'grok-3': { input: 3, output: 15, cache_read: 0.75, cache_write: 0 },
  'grok-3-mini': { input: 0.3, output: 0.5, cache_read: 0.075, cache_write: 0 },

  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28, cache_read: 0.014, cache_write: 0 },
  'deepseek-reasoner': { input: 0.14, output: 2.19, cache_read: 0.014, cache_write: 0 },
  'deepseek-coder': { input: 0.14, output: 0.28, cache_read: 0.014, cache_write: 0 },

  // GLM (zcode 模型)
  'GLM-4.5': { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 },
  'GLM-4.6': { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 },
  'GLM-5': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },
  'GLM-5.3': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },

  // MiniMax
  'MiniMaxAI/MiniMax-M3': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  'MiniMax-M3': { input: 0, output: 0, cache_read: 0, cache_write: 0 },

  // OpenCode 常见 free 模型
  'mimo-v2-pro-free': { input: 0, output: 0, cache_read: 0, cache_write: 0 }
}

let cached: PricingTable | null = null

function pricePath(): string {
  return join(app.getPath('userData'), 'model-pricing.json')
}

export function loadPricing(): PricingTable {
  if (cached) return cached
  const p = pricePath()
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as {
        models?: Record<string, ModelPrice>
      }
      cached = { ...DEFAULT, ...(raw.models ?? {}) }
      return cached
    } catch {
      // 忽略
    }
  }
  cached = { ...DEFAULT }
  return cached
}

export function savePricing(table: PricingTable): void {
  cached = table
  const p = pricePath()
  const dir = join(p, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify({ version: 1, models: table }, null, 2))
}

export function priceFor(model: string): ModelPrice {
  const t = loadPricing()
  // 精确匹配
  if (t[model]) return t[model]!
  // 模糊匹配：按前缀（处理 claude-opus-4-7 vs claude-opus-4）
  for (const k of Object.keys(t)) {
    if (model.startsWith(k) || k.startsWith(model)) return t[k]!
  }
  // 默认 0
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 }
}

/**
 * 算 cost (USD)
 * @param input 非缓存 input
 * @param output 输出
 * @param cacheRead 缓存读
 * @param cacheWrite 缓存写
 */
export function calcCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): number {
  const p = priceFor(model)
  return (
    (input / 1_000_000) * p.input +
    (output / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.cache_read +
    (cacheWrite / 1_000_000) * p.cache_write
  )
}
