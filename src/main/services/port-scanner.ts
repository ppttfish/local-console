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

  constructor(bus: EventBus) {
    this.bus = bus
  }

  async start(): Promise<void> {
    this.refreshServiceMap()
    this.refreshTimer = setInterval(() => this.refreshServiceMap(), 5000)
    await this.scan()
    this.timer = setInterval(() => void this.scan(), 2000)
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
    try {
      const rows = await this.runNetstat()
      const enriched = await this.enrich(rows)
      this.cache = enriched
      this.bus.emit_event({ type: 'port:changed', ports: enriched })
    } catch {
      // 静默
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
        /^\s*(TCP)\s+[\d.:]+\:(\d+)\s+[\d.:]+\:[\d\.]+\s+LISTENING\s+(\d+)/gm
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

  private async enrich(rows: NetstatRow[]): Promise<PortSnapshot[]> {
    const pids = [...new Set(rows.map((r) => r.pid))].join(',')
    const info = await this.getProcessInfo(pids)
    return rows.map((r) => {
      const i = info.get(r.pid) ?? { name: '?', cmd: '', cwd: null }
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
  }

  private getProcessInfo(
    pids: string
  ): Promise<Map<number, ProcessInfo>> {
    const { promise, resolve } = Promise.withResolvers<Map<number, ProcessInfo>>()
    if (!pids) {
      resolve(new Map())
      return promise
    }
    const script = `
$pids = @(${pids})
$out = @()
foreach ($p in $pids) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction Stop
    $exe = $proc.ExecutablePath
    $cwd = if ($exe) { Split-Path -Parent $exe } else { $null }
    $cmd = if ($proc.CommandLine) {
      $proc.CommandLine.Substring(0, [Math]::Min(200, $proc.CommandLine.Length))
    } else { '' }
    $out += [pscustomobject]@{ Pid = $p; Name = $proc.Name; Cwd = $cwd; Cmd = $cmd }
  } catch {}
}
$out | ConvertTo-Json -Compress
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
        const arr = JSON.parse(out.trim() || '[]') as Array<{
          Pid: number
          Name: string
          Cmd: string
          Cwd: string | null
        }>
        for (const r of arr) {
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
