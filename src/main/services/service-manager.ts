/**
 * 服务管理器 —— 启动/停止/重启服务，跟踪进程，触发事件。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join, basename } from 'node:path'
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  renameSync,
  type WriteStream
} from 'node:fs'
import { writeFile, readFile, stat as statAsync } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  listServices,
  getService,
  createServiceRow,
  updateServiceRow,
  deleteServiceRow,
  reorderServices,
  insertRunStart,
  updateRunPid,
  updateRunEnd,
  type ServiceRow
} from './db.js'
import { EventBus } from './event-bus.js'
import { pidAliveAsync, pidMemoryMb, pidMemoryMbAsync, triggerMemoryRefresh } from './proc-info.js'
import type {
  AppState,
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
  /** 日志写入流；轮转期间短暂为 null，此时写入进 pending */
  logStream: WriteStream | null
  /** 当前日志文件已写入字节数（内存计数，避免每次写盘都 statSync） */
  logBytes: number
  /** 轮转窗口内攒下的待写内容 */
  pending: string[]
  /** 微批次聚合：高频 stdout 时合并为一次 write，减少 syscall */
  logBatch: string[]
  logBatchBytes: number
  logFlushScheduled: boolean
}

/** 单个日志文件超过这个大小就轮转为 <id>.log.1，重新开始写 */
const LOG_MAX_BYTES = 2 * 1024 * 1024
/** 日志被清空后到轮转重建之前，允许攒这么多待写内容，超出直接丢弃 */
const LOG_PENDING_MAX = 64 * 1024
const STARTUP_GRACE_MS = 1500
/** 配了端口的服务：等端口真正监听的上限。超时进程仍活着则降级为 running 并告警 */
const STARTUP_PORT_TIMEOUT_MS = 30_000
const STARTUP_PORT_POLL_MS = 500
const STOP_GRACE_MS = 5000
const RESTART_DELAY_MS = 500

export class ServiceManager {
  private procs = new Map<string, RunningProc>()
  private statuses = new Map<string, ServiceStatus>()
  private lastExitCode = new Map<string, number | null>()
  private bus: EventBus
  private paths: ServiceManagerPaths
  /** 端口快照提供者（由运行时注入 PortScanner.snapshot），用于合并 listening 信息 */
  private portProvider: (() => PortSnapshot[]) | null = null
  private memRefreshTimer: ReturnType<typeof setInterval> | undefined = undefined

  constructor(bus: EventBus, paths: ServiceManagerPaths) {
    this.bus = bus
    this.paths = paths
  }

  /** 在 PortScanner 就绪后注入，供 toState 合并端口占用信息 */
  setPortProvider(provider: () => PortSnapshot[]): void {
    this.portProvider = provider
  }

  async start(): Promise<void> {
    for (const s of listServices()) {
      this.statuses.set(s.id, 'stopped')
    }
    // 后台内存采样：每 5s 异步刷新一次 wmic，避免快照热路径同步 spawn 导致卡顿
    if (!this.memRefreshTimer) {
      this.memRefreshTimer = setInterval(() => {
        const pids = this.managedPids()
        if (pids.length > 0) triggerMemoryRefresh(pids)
      }, 5000)
    }
  }

  async shutdown(): Promise<void> {
    if (this.memRefreshTimer) {
      clearInterval(this.memRefreshTimer)
      this.memRefreshTimer = undefined
    }
    await this.stopAll()
  }

  /**
   * 构造一次完整的应用状态快照。
   * IPC 与 HTTP 两条链路共用，避免两边各写一份、指标口径再分叉。
   */
  snapshotState(): AppState {
    const services = this.list()
    let totalMem = 0
    for (const s of services) {
      if (s.mem_mb !== null) totalMem += s.mem_mb
    }
    return {
      services,
      ports: this.portProvider?.() ?? [],
      total_mem_mb: Math.round(totalMem * 10) / 10,
      alerts: [],
      captured_at: Date.now()
    }
  }

  list(): ServiceState[] {
    const rows = listServices()
    const mem = pidMemoryMb(this.managedPids())
    // 极致：端口表转 Map，100 服务 × 50 端口时由 O(N*M) 降为 O(N+M)
    const portMap = this.buildPortMap()
    return rows.map((s) => this.toState(s, mem, portMap))
  }

  get(id: string): ServiceState | null {
    const s = getService(id)
    if (!s) return null
    const proc = this.procs.get(s.id)
    const mem = proc?.pid ? pidMemoryMb([proc.pid]) : null
    const portMap = this.buildPortMap()
    return this.toState(s, mem ?? undefined, portMap)
  }

  private buildPortMap(): Map<number, PortSnapshot> | null {
    if (!this.portProvider) return null
    const arr = this.portProvider()
    const m = new Map<number, PortSnapshot>()
    for (const p of arr) m.set(p.port, p)
    return m
  }

  /** 异步 variant：需要最新内存时用（非热路径），会等待 wmic 完成 */
  async listAsync(): Promise<ServiceState[]> {
    const rows = listServices()
    const pids = this.managedPids()
    const mem = pids.length > 0 ? await pidMemoryMbAsync(pids) : new Map()
    const portMap = this.buildPortMap()
    return rows.map((s) => this.toState(s, mem, portMap))
  }

  private managedPids(): number[] {
    const out: number[] = []
    for (const p of this.procs.values()) {
      if (p.pid !== null) out.push(p.pid)
    }
    return out
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

  async delete(id: string): Promise<void> {
    // 必须等进程真的停了再删记录：原来是 fire-and-forget，
    // 条目先消失、进程还在跑，端口也还占着，UI 上就再也收不到它。
    await this.stop(id, 'system')
    deleteServiceRow(id)
    this.statuses.delete(id)
    this.lastExitCode.delete(id)
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
    try {
      await statAsync(s.cwd)
    } catch {
      return { ok: false, error: `工作目录不存在: ${s.cwd}` }
    }
    if (!existsSync(this.paths.logsDir)) {
      mkdirSync(this.paths.logsDir, { recursive: true })
    }
    const logPath = join(this.paths.logsDir, `${id}.log`)
    const header = `--- ${new Date().toISOString()} start ---\n`
    try { await writeFile(logPath, header) } catch {}
    // 非热路径的二次校验仍用同步，但包 try 避免异常冒泡
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
      trigger,
      logStream: null,
      logBytes: Buffer.byteLength(header),
      pending: [],
      logBatch: [],
      logBatchBytes: 0,
      logFlushScheduled: false
    }
    this.procs.set(id, proc)
    this.openLogStream(proc)

    if (pid !== null) {
      // pid 要等 spawn 之后才拿得到，回填到 run_history，否则历史记录里全是 NULL
      updateRunPid(runId, pid)
    }

    child.stdout?.on('data', (buf: Buffer) => {
      this.appendLog(proc, buf)
      this.bus.emit_event({
        type: 'service:log',
        service_id: id,
        text: buf.toString('utf8')
      })
    })
    child.stderr?.on('data', (buf: Buffer) => {
      this.appendLog(proc, buf)
      this.bus.emit_event({
        type: 'service:log',
        service_id: id,
        text: `[err] ${buf.toString('utf8')}`
      })
    })

    child.on('error', (err) => {
      this.appendLog(proc, `[error] ${err.message}\n`)
      this.bus.emit_event({
        type: 'alert',
        level: 'error',
        message: `${s.name} 启动失败: ${err.message}`
      })
    })

    child.on('exit', (code, signal) => {
      const exitCode = code ?? (signal ? -1 : 0)
      this.appendLog(proc, `--- exit code=${exitCode} signal=${signal} ---\n`)
      this.closeLogStream(proc)
      updateRunEnd(runId, exitCode)
      this.lastExitCode.set(id, exitCode)
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

    // 进程活着 ≠ 服务可用：shell 包装下 1.5s 时真正的服务进程往往还在
    // 初始化，端口远未监听，UI 若此时标 running 会显示假"运行中"。
    // 配了端口的服务等端口真正监听再标 running，让状态与实际可用对齐。
    const wantPort = s.port
    if (wantPort !== null && this.portProvider) {
      const deadline = Date.now() + STARTUP_PORT_TIMEOUT_MS
      let listening = false
      while (Date.now() < deadline) {
        if (!this.procs.has(id)) {
          // 等待期间进程退出，exit 回调已写日志并置 stopped/failed
          return { ok: false, error: '进程在启动过程中退出，请查看服务日志' }
        }
        if (this.portProvider().some((p) => p.port === wantPort)) {
          listening = true
          break
        }
        await new Promise<void>((r) => setTimeout(r, STARTUP_PORT_POLL_MS))
      }
      if (!listening) {
        // 超时但进程仍在：可能服务不监听该端口（或端口填错），不再阻塞，
        // 按旧逻辑标 running 并提示，避免卡死在"启动中"
        this.bus.emit_event({
          type: 'alert',
          level: 'warn',
          message: `${s.name} 进程已启动，但端口 ${wantPort} 超过 ${STARTUP_PORT_TIMEOUT_MS / 1000} 秒仍未监听，请检查服务日志`
        })
      }
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
    let settled = false
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(hardTimer)
      resolve(r)
    }
    const killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && pid !== null) {
          spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { shell: false })
        } else {
          child.kill('SIGKILL')
        }
      } catch (e) {
        finish({ ok: false, error: String(e) })
      }
    }, STOP_GRACE_MS)
    // 兜底：强制杀之后还没等到 exit 事件（句柄丢失 / 僵尸进程）就别再挂着了，
    // 否则这个 IPC 调用会永久 pending，UI 上的按钮永远转圈
    const hardTimer = setTimeout(() => {
      finish({ ok: true })
    }, STOP_GRACE_MS + 5000)
    child.once('exit', () => finish({ ok: true }))
    try {
      if (process.platform === 'win32' && pid !== null) {
        spawn('taskkill', ['/pid', String(pid), '/t'], { shell: false })
      } else {
        child.kill('SIGTERM')
      }
    } catch (e) {
      finish({ ok: false, error: String(e) })
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

  // ========== 日志写入 ==========

  private openLogStream(proc: RunningProc): void {
    try {
      const s = createWriteStream(proc.logPath, { flags: 'a' })
      s.on('error', () => {
        // 磁盘满 / 文件被外部占用：别让流错误冒成未捕获异常把主进程带崩
      })
      proc.logStream = s
    } catch {
      proc.logStream = null
    }
  }

  private closeLogStream(proc: RunningProc): void {
    this.flushLogBatch(proc)
    try {
      proc.logStream?.end()
    } catch {
      // ignore
    }
    proc.logStream = null
  }

  /**
   * 日志轮转：当前文件改名成 <id>.log.1，重新起一个空文件。
   *
   * 旧实现是「读整个 2MB 文件再写回最后 1MB」，一次同步读写 1~2MB，
   * 高频输出的服务会周期性卡住主进程。rename 是元数据操作，成本恒定。
   */
  private rotateLog(proc: RunningProc): void {
    this.flushLogBatch(proc)
    const old = proc.logStream
    proc.logStream = null

    const reopen = (): void => {
      try {
        renameSync(proc.logPath, `${proc.logPath}.1`)
      } catch {
        // 改不动就继续往原文件写，总比丢日志强
      }
      this.openLogStream(proc)
      proc.logBytes = 0
      const pending = proc.pending
      proc.pending = []
      for (const chunk of pending) this.appendLog(proc, chunk)
    }

    if (old) {
      try {
        old.end(reopen)
      } catch {
        reopen()
      }
    } else {
      reopen()
    }
  }

  /** 日志被 UI 清空后，内存里的字节计数要跟着归零，否则会提前触发轮转 */
  resetLogCounter(id: string): void {
    const proc = this.procs.get(id)
    if (!proc) return
    proc.logBytes = 0
    proc.pending = []
    proc.logBatch = []
    proc.logBatchBytes = 0
    proc.logFlushScheduled = false
  }

  private appendLog(proc: RunningProc, chunk: string | Buffer): void {
    const isBuf = typeof chunk !== 'string'
    const text = isBuf ? (chunk as Buffer).toString('utf8') : chunk
    const bytes = isBuf ? (chunk as Buffer).length : Buffer.byteLength(text)

    if (proc.logStream) {
      // 微批次：16ms 内聚合，减少高频小 write 的 syscall 次数
      proc.logBatch.push(text)
      proc.logBatchBytes += bytes
      proc.logBytes += bytes
      if (proc.logBatchBytes >= 8192 || proc.logBatch.length >= 32) {
        this.flushLogBatch(proc)
      } else if (!proc.logFlushScheduled) {
        proc.logFlushScheduled = true
        setImmediate(() => this.flushLogBatch(proc))
      }
      if (proc.logBytes > LOG_MAX_BYTES) this.rotateLog(proc)
    } else if (proc.pending.length === 0 && bytes < LOG_PENDING_MAX) {
      proc.pending.push(text)
    }
  }

  private flushLogBatch(proc: RunningProc): void {
    if (!proc.logStream || proc.logBatch.length === 0) {
      proc.logFlushScheduled = false
      return
    }
    const batch = proc.logBatch.join('')
    proc.logBatch = []
    proc.logBatchBytes = 0
    proc.logFlushScheduled = false
    try { proc.logStream.write(batch) } catch {}
  }

  private toState(
    s: ServiceRow,
    mem?: Map<number, number>,
    portMap?: Map<number, PortSnapshot> | null
  ): ServiceState {
    const proc = this.procs.get(s.id)
    let listening = false
    let portPid: number | null = null
    let portProcessName: string | null = null
    if (s.port) {
      const map = portMap ?? this.buildPortMap()
      const hit = map?.get(s.port)
      if (hit) {
        listening = true
        portPid = hit.pid
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
      last_exit_code: this.lastExitCode.get(s.id) ?? null,
      mem_mb: proc?.pid ? (mem?.get(proc.pid) ?? null) : null
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
    if (!(await pidAliveAsync(pid))) {
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
      if (!(await pidAliveAsync(pid))) return { ok: true, pid }
      await new Promise<void>((r) => setTimeout(r, 300))
    }
    return { ok: true, pid }
  }

  // ========== 项目识别 ==========
  // 极致：全异步，避免同步 stat/read 阻塞主线程（用户选目录时触发，非轮询但仍需不卡）
  async detectProject(cwd: string): Promise<ProjectDetection> {
    try {
      await statAsync(cwd)
    } catch {
      return { ok: false, cwd, name: basename(cwd), files: [], candidates: [] }
    }
    const name = basename(cwd)
    const files: string[] = []
    const candidates: ProjectDetection['candidates'] = []

    const pkgPath = join(cwd, 'package.json')
    let hasPkg = false
    try {
      await statAsync(pkgPath)
      hasPkg = true
    } catch {}
    if (hasPkg) {
      files.push('package.json')
      try {
        const raw = await readFile(pkgPath, 'utf8')
        const pkg = JSON.parse(raw) as {
          scripts?: Record<string, string>
          packageManager?: string
        }
        const scripts = pkg.scripts || {}
        let usePnpm = String(pkg.packageManager || '').includes('pnpm')
        let useYarn = false
        if (!usePnpm) {
          try { await statAsync(join(cwd, 'pnpm-lock.yaml')); usePnpm = true } catch {}
          if (!usePnpm) try { await statAsync(join(cwd, 'pnpm-workspace.yaml')); usePnpm = true } catch {}
        }
        if (!usePnpm) try { await statAsync(join(cwd, 'yarn.lock')); useYarn = true } catch {}
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

    let hasPy = false
    try { await statAsync(join(cwd, 'pyproject.toml')); hasPy = true } catch {}
    if (!hasPy) try { await statAsync(join(cwd, 'requirements.txt')); hasPy = true } catch {}
    if (hasPy) {
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

    let hasCargo = false
    try { await statAsync(join(cwd, 'Cargo.toml')); hasCargo = true } catch {}
    if (hasCargo) {
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

  // 同步兼容：保留给极少数同步调用方，回退为异步的同步快照（已不推荐）
  detectProjectSync(cwd: string): ProjectDetection {
    // 极致兜底：同步版仅做最小检查，避免在新代码中被误用
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { existsSync: es, readFileSync: rfs } = require('node:fs') as typeof import('node:fs')
      if (!es(cwd)) return { ok: false, cwd, name: basename(cwd), files: [], candidates: [] }
      const name = basename(cwd)
      const files: string[] = []
      const candidates: ProjectDetection['candidates'] = []
      const pkgPath = join(cwd, 'package.json')
      if (es(pkgPath)) {
        files.push('package.json')
        try {
          const pkg = JSON.parse(rfs(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
          const scripts = pkg.scripts || {}
          for (const [k, v] of Object.entries(scripts)) {
            if (typeof v !== 'string') continue
            candidates.push({ command: `npm ${k}`, label: `npm ${k}`, source: 'package.json', port: this.guessPort(v), kind: 'service', detail: v.slice(0, 80) })
          }
        } catch {}
      }
      return { ok: true, cwd, name, files, candidates }
    } catch {
      return { ok: false, cwd, name: basename(cwd), files: [], candidates: [] }
    }
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
