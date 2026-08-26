/**
 * Provider 适配器公共类型
 *  - QuotaSnapshot：标准化的"当前周期配额快照"
 *  - ProviderAdapter：每个服务商一个 fetch 实现
 *  - ConfigField：UI 动态渲染 config 表单的字段描述
 *  - RefreshResult：成功返 snapshot，失败返错误短消息（不抛）
 */
import type { Subscription } from '../subscriptions.js'

export interface QuotaSnapshot {
  used: number
  limit: number
  remaining: number
  usedPct: number
  windowStart?: number
  windowEnd?: number
  currency?: string
  extra?: Record<string, unknown>
}

export type RefreshResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; error: string }

export type ConfigFieldType = 'text' | 'number' | 'select' | 'password'

export interface ConfigField {
  key: string
  label: string
  type: ConfigFieldType
  required?: boolean
  options?: string[]
  placeholder?: string
  hint?: string
}

export interface ProviderAdapter {
  id: string
  label: string
  builtin: boolean
  defaultConfig: Record<string, unknown>
  configSchema: ConfigField[]
  fetch(sub: Subscription): Promise<RefreshResult>
}
