/**
 * 订阅监控 —— 渲染端共享类型
 * 与主进程 src/main/plugins/builtin/token-usage/providers/types.ts 对齐
 */

export interface QuotaWindow {
  /** 窗口标签：'5h' / 'weekly' / 'MCP Tools' 等 */
  label: string
  usedPct: number | null
  resetAt: number | null
  valueLabel?: string | null
}

export interface QuotaSnapshot {
  used?: number
  limit?: number
  remaining?: number
  usedPct?: number
  windowStart?: number
  windowEnd?: number
  currency?: string
  planLabel?: string | null
  windows?: QuotaWindow[]
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

/** OpenCode auth.json 里发现的凭证（掩码） */
export interface DiscoveredCredential {
  providerId: string
  authKey: string
  masked: string
}
