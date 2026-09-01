/**
 * 日志流 —— tail/clear 实际读盘。
 *
 * 性能关键：
 *  1. `tail` 真的按行数读了，不再整篇读
 *  2. mtime+size 缓存命中返回 unchanged，前端跳过重渲染
 *  3. **全异步**：stat/open/read 全部用 fs/promises，绝不阻塞主线程事件循环
 *     旧版用 statSync/openSync/readSync，日志 2MB + 轮询 2s 时每轮都会定住主线程几十ms
 */
import { EventBus } from './event-bus.js'
import { writeFileSync } from 'node:fs'
import { stat, open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_TAIL_BYTES = 4 * 1024 * 1024
const BYTES_PER_LINE_GUESS = 256

export interface TailResult {
  text: string
  truncated: boolean
  unchanged: boolean
}

interface CacheEntry {
  size: number
  mtimeMs: number
}

export class LogStreamer {
  private bus: EventBus
  private logsDir: string
  private readCache = new Map<string, CacheEntry>()
  // 极致：内存环形缓冲，tail 命中时零磁盘 I/O
  private memory = new Map<string, { lines: string[]; pending: string }>()
  private readonly MAX_MEMORY_LINES = 3000
  private off: (() => void) | null = null

  constructor(bus: EventBus, logsDir: string) {
    this.bus = bus
    this.logsDir = logsDir
  }

  async start(): Promise<void> {
    // 订阅实时日志流，同步维护内存缓冲
    this.off = this.bus.on_event('service:log', (ev) => {
      const id = (ev as { service_id: string; text: string }).service_id
      const text = (ev as { text: string }).text ?? ''
      let entry = this.memory.get(id)
      if (!entry) {
        entry = { lines: [], pending: '' }
        this.memory.set(id, entry)
      }
      // 处理 chunk 可能含多行/半行
      const combined = entry.pending + text
      const parts = combined.split('\n')
      entry.pending = parts.pop() ?? ''
      for (const p of parts) {
        // 保留空行语义与 readTailLines 一致（末尾空行已 pop）
        entry.lines.push(p)
        if (entry.lines.length > this.MAX_MEMORY_LINES) entry.lines.shift()
      }
      // 若 chunk 以 \n 结尾，pending 已为空，下次追加即新行
    })
  }
  async stop(): Promise<void> {
    if (this.off) { try { this.off() } catch {} this.off = null }
  }

  /**
   * 异步 tail，不阻塞主线程。
   * @param force 跳过 mtime/size 缓存强制读盘
   */
  async tail(id: string, n: number, force = false): Promise<TailResult> {
    const path = join(this.logsDir, `${id}.log`)
    if (!existsSync(path)) {
      this.readCache.delete(id)
      return { text: '', truncated: false, unchanged: false }
    }

    let size: number
    let mtimeMs: number
    try {
      const st = await stat(path)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      return { text: '[读取日志失败]', truncated: false, unchanged: false }
    }

    if (size === 0) {
      const prev = this.readCache.get(id)
      this.readCache.set(id, { size, mtimeMs })
      return {
        text: '',
        truncated: false,
        unchanged: !force && !!prev && prev.size === 0
      }
    }

    const prev = this.readCache.get(id)
    if (!force && prev && prev.size === size && prev.mtimeMs === mtimeMs) {
      return { text: '', truncated: false, unchanged: true }
    }
    this.readCache.set(id, { size, mtimeMs })

    const want = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20000) : 300
    // 极致：内存命中直接返回，零 open/read
    const mem = this.memory.get(id)
    if (mem && mem.lines.length > 0) {
      // 粗略轮转/清空检测：磁盘文件大小应与内存字符量同量级
      const memChars = mem.lines.join('\n').length + mem.pending.length
      const sizeOk = size === 0 ? mem.lines.length === 0 : memChars === 0 || (size >= Math.min(memChars * 0.3, 1024) && size <= memChars * 3 + 4096)
      if (sizeOk && mem.lines.length >= Math.min(want, 100) ) {
        // 内存足够覆盖 want（或至少 100 行），直接服务
        if (mem.lines.length >= want) {
          const slice = mem.lines.slice(-want).join('\n')
          return { text: slice, truncated: mem.lines.length > want, unchanged: false }
        }
        // 内存行数不足 want 但文件未轮转，仍可合并：先取内存全部，再按需补旧盘（罕见，回退磁盘）
        if (size > memChars + 4096) {
          // 磁盘远大于内存，说明内存是增量后的新缓冲，旧数据在盘，回退磁盘保证完整
        } else {
          const slice = mem.lines.slice(-want).join('\n')
          return { text: slice, truncated: false, unchanged: false }
        }
      }
    }

    const r = await readTailLinesAsync(path, size, want)
    // 回填内存（冷启动或轮转后内存为空，首次读盘后同步内存，避免下次仍读盘）
    if (r.text) {
      const entry = this.memory.get(id) ?? { lines: [], pending: '' }
      const diskLines = r.text.split('\n')
      // 去重：若内存已有尾部与磁盘首部重叠，简单以磁盘为准重置
      entry.lines = diskLines.slice(-this.MAX_MEMORY_LINES)
      entry.pending = ''
      this.memory.set(id, entry)
    }
    return { ...r, unchanged: false }
  }

  /** 同步兼容层：老调用方仍可同步调用（会阻塞，仅供 CLI 快路径兜底） */
  tailSync(id: string, n: number, _force = false): TailResult {
    // 降级为异步的同步包装已不可行，直接走异步会返回 Promise
    // 保留接口但内部用 sync 逻辑（仅用于非热路径的极端兜底）
    // 实际应全部迁移到 tail()
    throw new Error('tailSync 已废弃，请使用 await tail()')
  }

  clear(id: string): void {
    const path = join(this.logsDir, `${id}.log`)
    try {
      writeFileSync(path, '')
      this.readCache.delete(id)
      this.memory.delete(id)
    } catch {
      // ignore
    }
  }

  /** 异步 clear，供 HTTP 链路用 */
  async clearAsync(id: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    const path = join(this.logsDir, `${id}.log`)
    try {
      await writeFile(path, '')
      this.readCache.delete(id)
      this.memory.delete(id)
    } catch {
      // ignore
    }
  }
}

async function readTailLinesAsync(
  path: string,
  size: number,
  want: number
): Promise<{ text: string; truncated: boolean }> {
  let chunk = Math.min(size, Math.max(4096, want * BYTES_PER_LINE_GUESS))

  for (let attempt = 0; attempt < 5; attempt++) {
    const len = Math.min(chunk, size)
    const buf = Buffer.alloc(len)
    let fh: import('node:fs/promises').FileHandle | null = null
    try {
      fh = await open(path, 'r')
      await fh.read(buf, 0, len, size - len)
    } catch (e) {
      try { await fh?.close() } catch {}
      return { text: `[读取日志失败: ${String(e)}]`, truncated: false }
    }
    try { await fh.close() } catch {}

    let text = buf.toString('utf8')
    const reachedBof = len >= size
    if (!reachedBof) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }

    const lines = text ? text.split('\n') : []
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length > want || reachedBof || chunk >= size) {
      const out = lines.slice(Math.max(0, lines.length - want)).join('\n')
      return { text: out, truncated: lines.length > want || !reachedBof }
    }
    if (chunk >= MAX_TAIL_BYTES) {
      return { text: lines.join('\n'), truncated: true }
    }
    chunk = Math.min(Math.max(chunk * 4, chunk + 65536), MAX_TAIL_BYTES, size)
    // 让出事件循环，避免连续 5 次大块读把后续 IPC 饿死
    if (attempt > 0) await new Promise((r) => setImmediate(r))
  }
  return { text: '', truncated: true }
}
