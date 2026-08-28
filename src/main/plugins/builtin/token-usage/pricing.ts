/**
 * 模型定价 —— 美元 / 1M tokens
 * 跟 ccswitch 的 model-pricing.json 思路一致：维护一个静态表
 * 用户可在 UI 里改后写到磁盘
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getDbPath } from '../../../services/db.js'

export interface ModelPrice {
  input: number
  output: number
  cache_read: number
  /** 5 分钟缓存写入（Anthropic 1.25×） */
  cache_write: number
  /** 1 小时缓存写入（Anthropic 2×）；未配置时按 cache_write * 1.6 推导 */
  cache_write_1h?: number
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

  // Anthropic — cache_write 为 5m（1.25×），cache_write_1h 为 1h（2×），参考 ccusage#899
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, cache_write_1h: 30 },
  'claude-opus-4-7': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, cache_write_1h: 30 },
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
  'claude-haiku-4': { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1, cache_write_1h: 1.6 },
  'claude-3-5-sonnet': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1, cache_write_1h: 1.6 },
  'claude-3-opus': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, cache_write_1h: 30 },

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

  // GLM (zcode 模型) — GLM-5.2 按 codeburn 别名 glm-5p1 (GLM-5.1) 计费，LiteLLM 暂无独立定价
  'GLM-4.5': { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 },
  'GLM-4.6': { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 },
  'GLM-5': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },
  'GLM-5.1': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },
  'GLM-5.2': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },
  'GLM-5.3': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },
  'glm-5p1': { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 },

  // MiniMax
  'MiniMaxAI/MiniMax-M3': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  'MiniMax-M3': { input: 0, output: 0, cache_read: 0, cache_write: 0 },

  // OpenCode 常见 free 模型
  'mimo-v2-pro-free': { input: 0, output: 0, cache_read: 0, cache_write: 0 }
}

let cached: PricingTable | null = null

function pricePath(): string {
  // 不能依赖 electron 的 app.getPath：MCP 子进程是 ELECTRON_RUN_AS_NODE=1 跑的，
  // 那里 require('electron') 拿不到 app，会直接崩。
  // db 一定已初始化（GUI / standalone / MCP 三个入口都先 initDatabase），
  // 从 db 文件路径推 userData 目录，口径与 app.getPath('userData') 完全一致。
  const dbPath = getDbPath()
  const dir = dbPath ? dirname(dbPath) : process.cwd()
  return join(dir, 'model-pricing.json')
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
 * @param input 非缓存 input (fresh)
 * @param output 输出（含 reasoning 后的输出）
 * @param cacheRead 缓存读（命中）
 * @param cacheWrite 缓存写：5m 桶；若存在 1h 拆分则此参数为 5m 部分
 * @param cacheWrite1h 1h 缓存写（Anthropic 2×）；为 0 时不计
 */
export function calcCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h = 0
): number {
  const p = priceFor(model)
  const write1hPrice = p.cache_write_1h ?? (p.cache_write > 0 ? (p.cache_write * 1.6) : 0)
  return (
    (input / 1_000_000) * p.input +
    (output / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.cache_read +
    (cacheWrite / 1_000_000) * p.cache_write +
    (cacheWrite1h / 1_000_000) * write1hPrice
  )
}
