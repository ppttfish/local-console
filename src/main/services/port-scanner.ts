/**
 * 端口扫描器 —— 每 2 秒扫描一次本机监听端口。
 * Windows: netstat + WMI 拿 PID、cwd、命令
 */
import { spawn } from 'node:child_process'
import { EventBus } from './event-bus.js'
import { listServices } from './db.js'
import type { PortSnapshot } from '@shared/types'

interface NetstatRow {
  proto: string
  port: number
  pid: number
}

interface ProcessInfo {
  name: string
  cmd: string
  cwd: string | null
}

type IntervalHandle = ReturnType<typeof setInterval>

export class PortScanner {
  private timer: IntervalHandle | undefined = undefined
  private refreshTimer: IntervalHandle | undefined = undefined
  private cache: PortSnapshot[] = []
  private bus: EventBus
  private servicesByPort = new Map<number, { id: string; name: string }>()
  /** PID → 进程信息。enrich 结果缓存：监听端口集合没变时直接复用，避免反复 spawn PowerShell */
  private procCache = new Map<number, ProcessInfo>()
  private lastPidKey = ''
  /** 上一次广播出去的端口签名；没变化就不重复推 */
  private lastPortSig = ''
  /** 防重入：一轮 scan（含 PowerShell 富化，可达数秒）没结束时跳过后续 tick，
   *  否则 2s interval 会不断叠出新的 PowerShell 进程把 CPU 打满 */
  private scanning = false

  constructor(bus: EventBus) {
    this.bus = bus
  }

  async start(): Promise<void> {
    this.refreshServiceMap()
    this.refreshTimer = setInterval(() => this.refreshServiceMap(), 5000)
    await this.scan()
    // 5 秒一轮。原来 2 秒一轮，而状态变化现在会主动推给渲染端，
    // 没必要让 netstat 每 2 秒 spawn 一次
    this.timer = setInterval(() => void this.scan(), 5000)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    clearInterval(this.refreshTimer)
    this.timer = undefined
    this.refreshTimer = undefined
  }

  snapshot(): PortSnapshot[] {
    return this.cache
  }

  private refreshServiceMap(): void {
    this.servicesByPort.clear()
    for (const s of listServices()) {
      if (s.port) {
        this.servicesByPort.set(s.port, { id: s.id, name: s.name })
      }
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const rows = await this.runNetstat()
      const pids = [...new Set(rows.map((r) => r.pid))].sort((a, b) => a - b)
      const pidSet = new Set(pids)
      const pidKey = pids.join(',')

      if (pidKey !== this.lastPidKey) {
        // 只对「没见过的 PID」做富化。原来只要有一个 PID 变化就全量重查，
        // 而 PID 集合里可能有上百个进程，每次变化都要付一次全量代价。
        const missing = pids.filter((p) => !this.procCache.has(p))
        if (missing.length > 0) {
          const info = await this.getProcessInfo(missing)
          for (const [k, v] of info) this.procCache.set(k, v)
        }
        // 回收已经不在监听集合里的 PID，避免缓存随进程 churn 无限增长
        for (const k of [...this.procCache.keys()]) {
          if (!pidSet.has(k)) this.procCache.delete(k)
        }
        this.lastPidKey = pidKey
      }

      this.cache = rows.map((r) => {
        const i = this.procCache.get(r.pid) ?? { name: '?', cmd: '', cwd: null }
        const svc = this.servicesByPort.get(r.port)
        return {
          port: r.port,
          pid: r.pid,
          process_name: i.name,
          cwd: i.cwd,
          cmd: i.cmd,
          app_id: svc?.id ?? null,
          app_name: svc?.name ?? null
        }
      })

      // 端口表没变就别推。监听端口在绝大多数轮询周期内是稳定的，
      // 无脑广播会让渲染端每 5 秒白跑一次 applyState。
      const sig = this.cache.map((p) => `${p.port}:${p.pid}`).join(',')
      if (sig !== this.lastPortSig) {
        this.lastPortSig = sig
        this.bus.emit_event({ type: 'port:changed', ports: this.cache })
      }
    } catch {
      // 静默
    } finally {
      this.scanning = false
    }
  }

  private runNetstat(): Promise<NetstatRow[]> {
    const { promise, resolve, reject } = Promise.withResolvers<NetstatRow[]>()
    const p = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('close', () => {
      const rows: NetstatRow[] = []
      const re =
        /^\s*(TCP)\s+[\d.:]+:(\d+)\s+[\d.:]+:[\d.]+\s+LISTENING\s+(\d+)/gm
      let m
      while ((m = re.exec(out)) !== null) {
        rows.push({
          proto: m[1]!,
          port: parseInt(m[2]!, 10),
          pid: parseInt(m[3]!, 10)
        })
      }
      resolve(rows)
    })
    p.on('error', reject)
    return promise
  }

  /**
   * 单次 PowerShell 批量拉取目标 PID 的进程信息。
   * 用 WMI 的 -Filter 把条件下推到服务端，而不是 `Get-CimInstance | Where-Object`
   * —— 后者要枚举机器上所有进程再在 PowerShell 里过滤，固定开销约 1.5s。
   */
  private getProcessInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
    const { promise, resolve } = Promise.withResolvers<Map<number, ProcessInfo>>()
    if (pids.length === 0) {
      resolve(new Map())
      return promise
    }
    const script = `
$filter = @(${pids.map((p) => `"ProcessId=${p}"`).join(',')}) -join ' OR '
Get-CimInstance -ClassName Win32_Process -Filter $filter | ForEach-Object {
  $cwd = if ($_.ExecutablePath) { Split-Path -Parent $_.ExecutablePath } else { $null }
  $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(200, $_.CommandLine.Length)) } else { '' }
  [pscustomobject]@{ Pid = $_.ProcessId; Name = $_.Name; Cwd = $cwd; Cmd = $cmd }
} | ConvertTo-Json -Compress
`
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    )
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('close', () => {
      const map = new Map<number, ProcessInfo>()
      try {
        const parsed = JSON.parse(out.trim() || '[]')
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        for (const r of arr as Array<{
          Pid: number
          Name: string
          Cmd: string
          Cwd: string | null
        }>) {
          map.set(r.Pid, { name: r.Name, cmd: r.Cmd || '', cwd: r.Cwd ?? null })
        }
      } catch {
        // ignore
      }
      resolve(map)
    })
    p.on('error', () => resolve(new Map()))
    return promise
  }
}
