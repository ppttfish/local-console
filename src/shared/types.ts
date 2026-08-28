/**
 * 跨进程共享类型契约 —— 主进程、preload、渲染端、MCP 工具统一引用。
 * 修改此文件前先想清楚：它是插件、MCP agent、UI 共同的协议。
 */

export type ServiceKind = 'service' | 'task'
export type TriggerSource = 'ui' | 'cli' | 'mcp' | 'system'
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface Service {
  id: string
  name: string
  kind: ServiceKind
  cwd: string
  command: string
  port: number | null
  color: string | null
  group_name: string | null
  created_at: number
  updated_at: number
}

export interface ServiceState extends Service {
  status: ServiceStatus
  pid: number | null
  uptime_sec: number
  /** 该服务配置的端口当前是否有进程在监听（含外部进程） */
  listening: boolean
  port_occupied_pid: number | null
  /** 端口监听进程名；监听者是本台托管进程时为 null */
  port_process_name?: string | null
  /** 上一次运行的退出码；本次进程启动后为 null */
  last_exit_code: number | null
  /** 进程占用的物理内存（MB）；进程不在运行或查询不到时为 null */
  mem_mb: number | null
}

export interface PortSnapshot {
  port: number
  pid: number
  process_name: string
  cwd: string | null
  cmd: string
  app_id: string | null
  app_name: string | null
}

export interface AppState {
  services: ServiceState[]
  ports: PortSnapshot[]
  /**
   * 托管进程占用的物理内存合计（MB）。
   * 只统计本台拉起且仍在运行的进程；5 秒采样一次，查不到时为 0。
   */
  total_mem_mb: number
  alerts: Alert[]
  captured_at: number
}

export interface Alert {
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

export interface RunHistory {
  id: number
  service_id: string
  started_at: number
  ended_at: number | null
  exit_code: number | null
  pid: number | null
  trigger: TriggerSource
  trigger_detail: string | null
}

export interface LogChunk {
  text: string
  truncated: boolean
}

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface CreateServiceInput {
  name: string
  kind: ServiceKind
  cwd: string
  command: string
  port?: number | null
  color?: string | null
  group_name?: string | null
}

export interface UpdateServiceInput extends Partial<CreateServiceInput> {
  id: string
}

export interface ProjectCandidate {
  command: string
  label: string
  source: string
  port: number | null
  kind: ServiceKind
  detail: string
}

export interface ProjectDetection {
  ok: boolean
  cwd: string
  name: string
  files: string[]
  candidates: ProjectCandidate[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
}

// ===== token-usage 回顾（Wrapped）=====
export interface UsageRecapTotals {
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cache_hit_ratio: number
  cost_usd: number
  calls: number
}

export interface UsageRecapTopModel {
  model: string
  tokens: number
  calls: number
  cost: number
  cache_read: number
  cache_hit_ratio: number
  /** 占全部 token 的百分比（0-100） */
  share: number
}

export interface UsageRecapDay {
  /** YYYY-MM-DD（UTC+8） */
  date: string
  tokens: number
  cost: number
  /** 当天用过的平台数 */
  agents: number
}

export interface UsageRecap {
  totals: UsageRecapTotals
  first_at: number | null
  last_at: number | null
  active_days: number
  peak_day: { day: string; tokens: number; cost: number } | null
  top_model: UsageRecapTopModel | null
  by_model: Array<{ model: string; tokens: number; cost: number; calls: number }>
  /** 24 桶（UTC+8 小时）调用次数 */
  hour_histogram: number[]
  days: UsageRecapDay[]
  /** 截至最近活跃日的连续天数 */
  streak_days: number
  /** 历史最长连续天数 */
  best_streak: number
}
