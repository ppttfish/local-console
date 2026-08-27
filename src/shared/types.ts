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
  last_exit_code: number | null
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
  total_cpu: number
  total_mem: number
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
