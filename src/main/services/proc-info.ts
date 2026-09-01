/**
 * Windows 进程信息查询工具集
 *
 * 设计目标：把"按 PID 查进程元数据"这件事从 PortScanner 和 ServiceManager
 * 里抽出来，做成幂等、可批量的纯函数。所有接口同步返回。
 *
 * 性能策略：
 *   - `pidSnapshot(pids)` 用一次 `wmic` 批量拿 N 个 PID 的 CommandLine / ExecutablePath / UserName
 *   - `pidAlive` 用 `tasklist /fi "PID eq N"` 单次校验
 *
 * Windows 特性说明：
 *   - 没有 PGID；用 PID 唯一化
 *   - 启动器注入的 token 通过命令行 set LCP_RUN_TOKEN=xxx 传递，校验时回看 cmdline
 *   - 同用户校验：UserName 字段是 DOMAIN\Account，跟 os.userInfo().username 比较
 */
import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'

export interface ProcInfo {
  pid: number
  alive: boolean
  /** 完整命令行。进程已退出时为 '' */
  cmdline: string
  /** 工作目录估算。可能为 null（系统进程或权限不足） */
  cwd: string | null
  /** 进程用户名。格式 DOMAIN\Account */
  username: string | null
}

let selfUsername: string | null = null
function getSelfUsername(): string {
  if (selfUsername !== null) return selfUsername
  try {
    selfUsername = userInfo().username
  } catch {
    selfUsername = ''
  }
  return selfUsername
}

/** 用 tasklist 校验单个 PID 是否存活（同步，阻塞）。非热路径可用；热路径请用 pidAliveAsync。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  const r = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/nh', '/fo', 'csv'], {
    windowsHide: true,
    shell: false,
    timeout: 5000,
    encoding: 'utf8'
  })
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return false
  // tasklist 输出形如 "node.exe","1234","Console","1","12,345 K"
  // 没找到时会输出 INFO: No tasks...
  return r.stdout.includes(`,"${pid}",`)
}

/** 异步版 pidAlive，不阻塞主线程（热路径/轮询用）。 */
export function pidAliveAsync(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return Promise.resolve(false)
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const p = spawn('tasklist', ['/fi', `pid eq ${pid}`, '/nh', '/fo', 'csv'], {
    windowsHide: true,
    shell: false
  })
  let out = ''
  let done = false
  const finish = (v: boolean) => {
    if (done) return
    done = true
    resolve(v)
  }
  p.stdout.on('data', (d) => (out += d.toString()))
  p.on('close', (code) => {
    if (code !== 0) finish(false)
    else finish(out.includes(`,"${pid}",`))
  })
  p.on('error', () => finish(false))
  setTimeout(() => finish(false), 5000).unref()
  return promise
}

/**
 * 批量进程快照。
 * 一次 wmic 拉 N 个 PID 的 CommandLine / ExecutablePath / UserName。
 */
export function pidSnapshot(pids: number[]): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>()
  if (pids.length === 0) return out
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))]
  if (unique.length === 0) return out

  const whereClause = unique.map((p) => `ProcessId=${p}`).join(' or ')
  const r = spawnSync(
    'wmic',
    [
      'process',
      'where',
      whereClause,
      'get',
      'ProcessId,CommandLine,ExecutablePath,UserName',
      '/format:csv'
    ],
    {
      windowsHide: true,
      shell: false,
      timeout: 30_000,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    }
  )

  if (r.error || typeof r.stdout !== 'string') {
    for (const p of unique) out.set(p, { pid: p, alive: false, cmdline: '', cwd: null, username: null })
    return out
  }

  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    for (const p of unique) out.set(p, { pid: p, alive: false, cmdline: '', cwd: null, username: null })
    return out
  }

  const header = lines[0]!.split(',')
  const idxPid = header.indexOf('ProcessId')
  const idxCmd = header.indexOf('CommandLine')
  const idxExe = header.indexOf('ExecutablePath')
  const idxUser = header.indexOf('UserName')

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',')
    const pid = parseInt(cells[idxPid] ?? '', 10)
    if (!Number.isFinite(pid)) continue
    out.set(pid, {
      pid,
      alive: true,
      cmdline: (cells[idxCmd] ?? '').trim(),
      cwd: deriveCwdFromExe((cells[idxExe] ?? '').trim()),
      username: (cells[idxUser] ?? '').trim() || null
    })
  }
  for (const p of unique) {
    if (!out.has(p)) out.set(p, { pid: p, alive: false, cmdline: '', cwd: null, username: null })
  }
  return out
}

/** Windows 上没可靠的轻量 API 直接拿进程 cwd。
 *  兜底用 ExecutablePath 推一个"合理猜测"——reconcile 时只作弱参考。 */
function deriveCwdFromExe(exe: string): string | null {
  if (!exe) return null
  const i = Math.max(exe.lastIndexOf('\\'), exe.lastIndexOf('/'))
  if (i <= 0) return null
  return exe.slice(0, i)
}

// ===== 进程内存 =====

const MEM_TTL_MS = 5000
let memCache: { at: number; map: Map<number, number> } | null = null
let memRefreshInFlight: Promise<Map<number, number>> | null = null

function parseWmicMemoryOutput(stdout: string): Map<number, number> {
  const map = new Map<number, number>()
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return map
  const header = lines[0]!.split(',')
  const iPid = header.indexOf('ProcessId')
  const iWs = header.indexOf('WorkingSetSize')
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',')
    const pid = parseInt(cells[iPid] ?? '', 10)
    const ws = parseInt(cells[iWs] ?? '', 10)
    if (Number.isFinite(pid) && Number.isFinite(ws) && ws > 0) {
      map.set(pid, Math.round((ws / 1024 / 1024) * 10) / 10)
    }
  }
  return map
}

function spawnWmicMemoryAsync(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return Promise.resolve(new Map())
  const whereClause = pids.map((p) => `ProcessId=${p}`).join(' or ')
  const { promise, resolve } = Promise.withResolvers<Map<number, number>>()
  const p = spawn(
    'wmic',
    ['process', 'where', whereClause, 'get', 'ProcessId,WorkingSetSize', '/format:csv'],
    { windowsHide: true, shell: false }
  )
  let out = ''
  let done = false
  const finish = (map: Map<number, number>) => {
    if (done) return
    done = true
    resolve(map)
  }
  p.stdout.on('data', (d) => (out += d.toString()))
  p.on('close', () => finish(parseWmicMemoryOutput(out)))
  p.on('error', () => finish(new Map()))
  setTimeout(() => finish(new Map()), 8000).unref()
  return promise
}

/**
 * 异步批量取进程物理内存（MB），不阻塞主线程。
 * 真正的查询在这里；同步版只读缓存。
 */
export async function pidMemoryMbAsync(pids: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))]
  if (unique.length === 0) return new Map()
  // 复用 TTL：缓存命中直接返回
  if (memCache && Date.now() - memCache.at < MEM_TTL_MS) {
    const out = new Map<number, number>()
    for (const p of unique) {
      const v = memCache.map.get(p)
      if (v !== undefined) out.set(p, v)
    }
    // 如果缓存已覆盖所有请求的 PID，直接返回
    if (out.size === unique.length) return out
  }
  if (memRefreshInFlight) {
    const map = await memRefreshInFlight
    const out = new Map<number, number>()
    for (const p of unique) {
      const v = map.get(p)
      if (v !== undefined) out.set(p, v)
    }
    return out
  }
  const task = spawnWmicMemoryAsync(unique).then((map) => {
    memCache = { at: Date.now(), map }
    return map
  }).finally(() => {
    memRefreshInFlight = null
  })
  memRefreshInFlight = task
  const map = await task
  const out = new Map<number, number>()
  for (const p of unique) {
    const v = map.get(p)
    if (v !== undefined) out.set(p, v)
  }
  return out
}

/** 后台触发一次内存刷新，不等待结果（供快照热路径调用，永不阻塞）。 */
export function triggerMemoryRefresh(pids: number[]): void {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))]
  if (unique.length === 0) return
  if (memCache && Date.now() - memCache.at < MEM_TTL_MS) return
  if (memRefreshInFlight) return
  void pidMemoryMbAsync(unique).catch(() => {})
}

/**
 * 同步批量取进程物理内存（MB）—— 只读缓存，永不 spawn。
 * 热路径（snapshotState/list）必须用它，避免主线程被 wmic 定住。
 * 首次/过期时返回空或旧缓存，后台会自动刷新，下次快照即有数据。
 */
export function pidMemoryMb(pids: number[]): Map<number, number> {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))]
  if (unique.length === 0) return new Map()
  if (memCache && Date.now() - memCache.at < MEM_TTL_MS) {
    const out = new Map<number, number>()
    for (const p of unique) {
      const v = memCache.map.get(p)
      if (v !== undefined) out.set(p, v)
    }
    return out
  }
  // 缓存过期：触发异步刷新，立即返回旧缓存（或空），绝不阻塞
  if (memCache) {
    const out = new Map<number, number>()
    for (const p of unique) {
      const v = memCache.map.get(p)
      if (v !== undefined) out.set(p, v)
    }
    triggerMemoryRefresh(unique)
    return out
  }
  triggerMemoryRefresh(unique)
  return new Map()
}

/** 供测试/启动时预热：强制同步刷新已废弃，请用 pidMemoryMbAsync */
export function invalidateMemoryCache(): void {
  memCache = null
}

/** 检查两个路径是否指向同一个真实路径。失败时返回 false（不抛）。 */
export function sameRealPath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** 在 cmdline 中查找 token。token 由 startService 注入命令行头。 */
export function cmdlineHasToken(cmdline: string, token: string): boolean {
  if (!cmdline || !token) return false
  return cmdline.includes(`LCP_RUN_TOKEN=${token}`) || cmdline.includes(token)
}

/** 当前用户名（已去 DOMAIN\ 前缀）。 */
export function currentUsername(): string {
  return getSelfUsername()
}

/** 是否属于当前用户。 */
export function isCurrentUser(info: ProcInfo): boolean {
  if (!info.username) return false
  const simple = info.username.includes('\\') ? info.username.split('\\').pop()! : info.username
  return simple === getSelfUsername()
}

/** 把 alive 的 PID 集合从输入中筛出来。 */
export function filterAlive(pids: number[]): number[] {
  if (pids.length === 0) return []
  const out: number[] = []
  for (const p of pids) if (pidAlive(p)) out.push(p)
  return out
}
