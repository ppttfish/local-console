/**
 * 订阅监控 —— 渲染端共享类型
 * 与主进程 src/main/plugins/builtin/token-usage/subscriptions.ts 的结构对齐
 */

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

export interface Sub {
  id: number
  provider: string
  displayName: string
  enabled: boolean
  lastRefreshAt: number | null
  lastError: string | null
  lastSnapshot: QuotaSnapshot | null
  config: Record<string, unknown>
}

export interface ConfigField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'password'
  required?: boolean
  options?: string[]
  placeholder?: string
  hint?: string
}

export interface ProviderMeta {
  id: string
  label: string
  builtin: boolean
  defaultConfig: Record<string, unknown>
  configSchema: ConfigField[]
  color: string
  short: string
}
