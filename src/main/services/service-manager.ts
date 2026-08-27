/**
 * 服务管理器 —— 启动/停止/重启服务，跟踪进程，触发事件。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join, basename } from 'node:path'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  writeFileSync,
  readFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  listServices,
  getService,
  createServiceRow,
  updateServiceRow,
  deleteServiceRow,
  reorderServices,
  insertRunStart,
  updateRunEnd,
  type ServiceRow
} from './db.js'
import { EventBus } from './event-bus.js'
import { LogStreamer } from './log-streamer.js'
import { attachToSessionJob } from '../utils/proc-tree.js'
import { pidAlive } from './proc-info.js'
import type {
  ServiceState,
  ServiceStatus,
  TriggerSource,
  ProjectDetection,
  PortSnapshot
} from '@shared/types'

export interface ServiceManagerPaths {
  userData: string
  logsDir: string
}

interface RunningProc {
  serviceId: string
  child: ChildProcess
  pid: number | null
  startedAt: number
  runId: number
  logPath: string
  trigger: TriggerSource
  /** 用户主动停止中：退出码非 0 也不算 failed（Windows taskkill 强杀退出码是 1） */
  stopRequested?: boolean
}

const LOG_MAX_BYTES = 2 * 1024 * 1024
const LOG_KEEP_BYTES = 1 * 1024 * 1024
const STARTUP_GRACE_MS = 1500
const STOP_GRACE_MS = 5000
const RESTART_DELAY_MS = 500

export class ServiceManager {
  private procs = new Map<string, RunningProc>()
  private statuses = new Map<string, ServiceStatus>()
  private bus: EventBus
  private logStreamer: LogStreamer
  private paths: ServiceManagerPaths
  /** 端口快照提供者（由运行时注入 PortScanner.snapshot），用于合并 listening 信息 */
  private portProvider: (() => PortSnapshot[]) | null = null

  constructor(bus: EventBus, paths: ServiceManagerPaths) {
    this.bus = bus
    this.paths = paths
    this.logStreamer = new LogStreamer(bus, paths.logsDir)
  }

  /** 在 PortScanner 就绪后注入，供 toState 合并端口占用信息 */
  setPortProvider(provider: () => PortSnapshot[]): void {
    this.portProvider = provider
  }

  async start(): Promise<void> {
    await this.logStreamer.start()
    for (const s of listServices()) {
      this.statuses.set(s.id, 'stopped')
    }
  }

  async shutdown(): Promise<void> {
    await this.stopAll()
    await this.logStreamer.stop()
  }

  list(): ServiceState[] {
    return listServices().map((s) => this.toState(s))
  }

  get(id: string): ServiceState | null {
    const s = getService(id)
    return s ? this.toState(s) : null
  }

  create(input: {
    name: string
    kind: 'service' | 'task'
    cwd: string
    command: string
    port?: number | null
    color?: string | null
    group_name?: string | null
  }): ServiceState {
    const now = Date.now()
    const row: ServiceRow = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      name: input.name,
      kind: input.kind,
      cwd: input.cwd,
      command: input.command,
      port: input.port ?? null,
      color: input.color ?? null,
      group_name: input.group_name ?? null,
      sort_order: listServices().length,
      created_at: now,
      updated_at: now
    }
    createServiceRow(row)
    this.statuses.set(row.id, 'stopped')
    return this.toState(row)
  }

  update(id: string, patch: Partial<ServiceRow>): ServiceState | null {
    updateServiceRow(id, patch)
    const s = getService(id)
    return s ? this.toState(s) : null
  }

  delete(id: string): void {
    void this.stop(id, 'system')
    deleteServiceRow(id)
    this.statuses.delete(id)
  }

  reorder(ids: string[]): void {
    reorderServices(ids)
  }

  async startService(
    id: string,
    trigger: TriggerSource = 'ui',
    detail?: string
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    if (this.procs.has(id)) {
      return { ok: false, error: '服务已在运行' }
    }
    const s = getService(id)
    if (!s) return { ok: false, error: '服务不存在' }
    if (!existsSync(s.cwd)) {
      return { ok: false, error: `工作目录不存在: ${s.cwd}` }
    }
    if (!existsSync(this.paths.logsDir)) {
      mkdirSync(this.paths.logsDir, { recursive: true })
    }
    const logPath = join(this.paths.logsDir, `${id}.log`)
    writeFileSync(logPath, `--- ${new Date().toISOString()} start ---\n`)
    const commandIssue = diagnoseCommand(s.command)
    if (commandIssue) {
      return {
        ok: false,
        error: `启动命令无效: ${commandIssue}。请编辑该条目后填写可执行命令。`
      }
    }


    this.setStatus(id, 'starting')
    this.bus.emit_event({
      type: 'alert',
      level: 'info',
      message: `${s.name} 启动中…`
    })

    const runId = insertRunStart({
      service_id: id,
      pid: null,
      pgid: null,
      trigger,
      trigger_detail: detail ?? null
    })

    let child: ChildProcess
    try {
      child = spawn(s.command, {
        cwd: s.cwd,
        shell: true,
        detached: false,
        windowsHide: true,
        env: { ...process.env, LCP_SERVICE_ID: id, FORCE_COLOR: '1' }
      })
    } catch (e) {
      this.setStatus(id, 'failed')
      return { ok: false, error: String(e) }
    }

    const pid = child.pid ?? null
    const proc: RunningProc = {
      serviceId: id,
      child,
      pid,
      startedAt: Date.now(),
      runId,
      logPath,
      trigger
    }
    this.procs.set(id, proc)

    if (pid !== null) {
      void attachToSessionJob(pid).catch(() => undefined)
    }

    child.stdout?.on('data', (buf: Buffer) => this.appendLog(proc, buf))
    child.stderr?.on('data', (buf: Buffer) =>
      this.appendLog(proc, buf, true)
    )

    child.on('error', (err) => {
      appendFileSync(logPath, `[error] ${err.message}\n`)
      this.bus.emit_event({
        type: 'alert',
        level: 'error',
        message: `${s.name} 启动失败: ${err.message}`
      })
    })

    child.on('exit', (code, signal) => {
      const exitCode = code ?? (signal ? -1 : 0)
      appendFileSync(
        logPath,
        `--- exit code=${exitCode} signal=${signal} ---\n`
      )
      updateRunEnd(runId, exitCode)
      this.procs.delete(id)
      const finalStatus: ServiceStatus =
        code === 0 || signal === 'SIGTERM' || proc.stopRequested
          ? 'stopped'
          : 'failed'
      this.setStatus(id, finalStatus)
      this.bus.emit_event({
        type: 'service:status',
        service_id: id,
        status: finalStatus,
        exit_code: exitCode
      })
      this.bus.emit_event({ type: 'state:changed' })
      this.bus.emit_event({
        type: 'alert',
        level: finalStatus === 'failed' ? 'error' : 'info',
        message: `${s.name} 已退出（code=${exitCode}）`
      })
    })

    const earlyExit = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STARTUP_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })

    if (earlyExit || !this.procs.has(id)) {
      return { ok: false, error: '进程启动后立即退出，请检查命令' }
    }

    this.setStatus(id, 'running')
    this.bus.emit_event({
      type: 'service:status',
      service_id: id,
      status: 'running',
      pid: pid ?? undefined
    })
    this.bus.emit_event({ type: 'state:changed' })

    return { ok: true, pid: pid ?? undefined }
  }

  async stop(
    id: string,
    trigger: TriggerSource = 'ui'
  ): Promise<{ ok: boolean; error?: string }> {
    void trigger
    const proc = this.procs.get(id)
    if (!proc) {
      this.setStatus(id, 'stopped')
      return { ok: true }
    }
    this.setStatus(id, 'stopping')
    proc.stopRequested = true
    const child = proc.child
    const pid = proc.pid

    const { promise, resolve } = Promise.withResolvers<{
      ok: boolean
      error?: string
    }>()
    const killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && pid !== null) {
          spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { shell: false })
        } else {
          child.kill('SIGKILL')
        }
      } catch (e) {
        resolve({ ok: false, error: String(e) })
      }
    }, STOP_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(killTimer)
      resolve({ ok: true })
    })
    try {
      if (process.platform === 'win32' && pid !== null) {
        spawn('taskkill', ['/pid', String(pid), '/t'], { shell: false })
      } else {
        child.kill('SIGTERM')
      }
    } catch (e) {
      clearTimeout(killTimer)
      resolve({ ok: false, error: String(e) })
    }
    return promise
  }

  async restart(
    id: string,
    trigger: TriggerSource = 'ui'
  ): Promise<{ ok: boolean; error?: string }> {
    await this.stop(id, trigger)
    await new Promise<void>((r) => setTimeout(r, RESTART_DELAY_MS))
    return this.startService(id, trigger, 'restart')
  }

  async stopAll(): Promise<void> {
    const ids = [...this.procs.keys()]
    for (const id of ids) await this.stop(id, 'system')
  }

  // ========== 内部 ==========

  private setStatus(id: string, status: ServiceStatus): void {
    this.statuses.set(id, status)
  }

  private appendLog(proc: RunningProc, buf: Buffer, isErr = false): void {
    const text = buf.toString('utf8')
    try {
      appendFileSync(proc.logPath, text)
      try {
        const sz = statSync(proc.logPath).size
        if (sz > LOG_MAX_BYTES) {
          const data = readFileSync(proc.logPath, 'utf8')
          writeFileSync(proc.logPath, data.slice(-LOG_KEEP_BYTES))
        }
      } catch {
        // ignore truncation
      }
    } catch {
      // ignore write failure
    }
    this.bus.emit_event({
      type: 'service:log',
      service_id: proc.serviceId,
      text: isErr ? `[err] ${text}` : text
    })
  }

  private toState(s: ServiceRow): ServiceState {
    const proc = this.procs.get(s.id)
    let listening = false
    let portPid: number | null = null
    let portProcessName: string | null = null
    if (s.port && this.portProvider) {
      const hit = this.portProvider().find((p) => p.port === s.port)
      if (hit) {
        listening = true
        portPid = hit.pid
        // 本台托管的进程由 pid 字段表达，外部占用才带进程名
        if (!proc || proc.pid !== hit.pid) {
          portProcessName = hit.process_name
        }
      }
    }
    return {
      ...s,
      status: this.statuses.get(s.id) ?? 'stopped',
      pid: proc?.pid ?? null,
      uptime_sec: proc ? Math.floor((Date.now() - proc.startedAt) / 1000) : 0,
      listening,
      port_occupied_pid: portPid,
      port_process_name: portProcessName,
      last_exit_code: null
    }
  }

  /**
   * 结束占用该服务端口的外部进程（外部接管条目的「停止」）。
   * 只允许杀「当前正监听该端口」的 PID，不能当任意进程杀手用；
   * 若监听者本就是本台托管的子进程，转走常规 stop 流程。
   */
  async stopExternal(
    id: string,
    _trigger: TriggerSource = 'ui'
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    void _trigger
    const s = getService(id)
    if (!s) return { ok: false, error: '服务不存在' }
    if (!s.port) return { ok: false, error: '该条目未配置端口，无法定位外部进程' }
    if (this.procs.has(id)) {
      const r = await this.stop(id, 'ui')
      return { ...r, ok: r.ok }
    }
    const hit = this.portProvider?.().find((p) => p.port === s.port)
    if (!hit) {
      return { ok: false, error: `端口 ${s.port} 当前没有监听进程` }
    }
    const pid = hit.pid
    // netstat 缓存最长 2 秒，二次确认 PID 仍存活，防止误杀到复用 PID 的新进程
    if (!pidAlive(pid)) {
      return { ok: false, error: `进程 ${pid} 已退出（端口数据尚未刷新）` }
    }
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: false })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
    // 等进程真正退出（最多 3 秒），给随后的「启动」一个干净端口
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return { ok: true, pid }
      await new Promise<void>((r) => setTimeout(r, 300))
    }
    return { ok: true, pid }
  }

  // ========== 项目识别 ==========

  detectProject(cwd: string): ProjectDetection {
    if (!existsSync(cwd)) {
      return { ok: false, cwd, name: basename(cwd), files: [], candidates: [] }
    }
    const name = basename(cwd)
    const files: string[] = []
    const candidates: ProjectDetection['candidates'] = []

    const pkgPath = join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      files.push('package.json')
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          scripts?: Record<string, string>
          packageManager?: string
        }
        const scripts = pkg.scripts || {}
        const usePnpm =
          existsSync(join(cwd, 'pnpm-lock.yaml')) ||
          existsSync(join(cwd, 'pnpm-workspace.yaml')) ||
          String(pkg.packageManager || '').includes('pnpm')
        const useYarn = existsSync(join(cwd, 'yarn.lock'))
        const runner = usePnpm ? 'pnpm' : useYarn ? 'yarn' : 'npm'
        const svcKeys = new Set([
          'd', 's', 'dev', 'start', 'serve', 'preview', 'p', 'run'
        ])
        for (const [k, v] of Object.entries(scripts)) {
          if (typeof v !== 'string') continue
          const kind = svcKeys.has(k) ? 'service' : 'task'
          const cmd =
            k === 'dev' && runner === 'npm' ? 'npm run dev' : `${runner} ${k}`
          candidates.push({
            command: cmd,
            label: cmd,
            source: 'package.json',
            port: this.guessPort(v),
            kind,
            detail: v.slice(0, 80)
          })
        }
      } catch {
        // ignore parse error
      }
    }

    if (
      existsSync(join(cwd, 'pyproject.toml')) ||
      existsSync(join(cwd, 'requirements.txt'))
    ) {
      files.push('python')
      candidates.push({
        command: 'python -m uvicorn main:app --reload',
        label: 'uvicorn (FastAPI)',
        source: 'python',
        port: 8000,
        kind: 'service',
        detail: '通用 FastAPI 启动'
      })
    }

    if (existsSync(join(cwd, 'Cargo.toml'))) {
      files.push('Cargo.toml')
      candidates.push({
        command: 'cargo run',
        label: 'cargo run',
        source: 'Cargo.toml',
        port: null,
        kind: 'service',
        detail: 'Rust 项目'
      })
    }

    return { ok: true, cwd, name, files, candidates }
  }

  private guessPort(cmd: string): number | null {
    const m = cmd.match(/--port[=\s]+(\d+)|-p\s+(\d+)|:(\d{4,5})/)
    if (m) {
      const p = parseInt(m[1] || m[2] || m[3] || '0', 10)
      if (p > 0 && p < 65536) return p
    }
    if (cmd.includes('vite')) return 5173
    if (cmd.includes('next')) return 3000
    if (cmd.includes('nuxt')) return 3000
    if (cmd.includes('astro')) return 4321
    if (cmd.includes('hexo')) return 4000
    if (cmd.includes('hugo')) return 1313
    if (cmd.includes('uvicorn') || cmd.includes('fastapi')) return 8000
    return null
  }
}
// 预检 command 是否能直接 exec。返回 null 表示 OK；否则返回用户可读的错误说明。
function diagnoseCommand(command: string): string | null {
  if (!command || !command.trim()) return '启动命令为空'
  // .pnpm 虚拟 store 路径基本都不能直接执行，常见于从运行中进程回填的
  // command（store 路径可能出现在参数位置，所以要查整条命令）
  if (command.includes('.pnpm') && command.includes('@')) {
    return '命令包含 pnpm 虚拟 store 路径（通常是从运行中进程回填的完整命令行），无法照此启动；请改成简短的可执行命令（如 dsh web），工作区也换成固定目录'
  }
  const first = command.trim().split(/\s+/)[0] ?? ''
  const unquoted = first.replace(/^["']|["']$/g, '')
  // 绝对路径：检查文件是否存在
  if (/^[A-Za-z]:[\\/]/.test(unquoted) || unquoted.startsWith('\\\\')) {
    return existsSync(unquoted) ? null : `可执行文件不存在: ${unquoted}`
  }
  // 相对路径：交由 shell resolve（PATH 或 cwd 相对），这里只做存在性 sanity check
  // —— 不存在的 PATH 工具会被 shell 报 not found，留给 spawn 自然失败
  return null
}
