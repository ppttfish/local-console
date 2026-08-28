/**
 * 日志流 —— tail/clear 实际读盘。
 *
 * 读侧的两个关键点：
 *  1. `tail` 真的按行数读了。旧实现直接忽略传进来的 n，只要文件小于 2MB 就整篇
 *     读出来，UI 上"最近 100 行"完全没生效，选 100 行照样传 2MB 过 IPC。
 *  2. 加了 mtime+size 缓存。渲染端每 2 秒轮询一次，而日志绝大多数时间没变化，
 *     命中缓存时返回 unchanged，前端直接跳过重渲染（原来每 2 秒要重建 1000 个 div）。
 */
import { EventBus } from './event-bus.js'
import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** 单次回读的最大字节数；超过就放弃"凑满 n 行"，返回已读到的部分 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024
/** 首轮猜测：平均每行 256 字节，够大多数场景一次命中 */
const BYTES_PER_LINE_GUESS = 256

export interface TailResult {
  text: string
  truncated: boolean
  /** 与上次读取相比文件没有变化，调用方可以直接沿用旧内容 */
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

  constructor(bus: EventBus, logsDir: string) {
    this.bus = bus
    this.logsDir = logsDir
  }

  async start(): Promise<void> {
    // 保留接口
  }
  async stop(): Promise<void> {
    // 保留接口
  }

  tail(id: string, n: number): TailResult {
    const path = join(this.logsDir, `${id}.log`)
    if (!existsSync(path)) {
      this.readCache.delete(id)
      return { text: '', truncated: false, unchanged: false }
    }

    let size: number
    let mtimeMs: number
    try {
      const st = statSync(path)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      return { text: '[读取日志失败]', truncated: false, unchanged: false }
    }

    if (size === 0) {
      const prev = this.readCache.get(id)
      this.readCache.set(id, { size, mtimeMs })
      // 空文件也算一种"状态"，只有从非空变空才需要刷新
      return { text: '', truncated: false, unchanged: !!prev && prev.size === 0 }
    }

    const prev = this.readCache.get(id)
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) {
      return { text: '', truncated: false, unchanged: true }
    }
    this.readCache.set(id, { size, mtimeMs })

    const want = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20000) : 300
    return { ...readTailLines(path, size, want), unchanged: false }
  }

  clear(id: string): void {
    const path = join(this.logsDir, `${id}.log`)
    try {
      writeFileSync(path, '')
      this.readCache.delete(id)
    } catch {
      // ignore
    }
  }
}

/**
 * 从文件尾部回读，凑够 want 行就停。
 *
 * 先在平均行长假设下估一个字节数；不够就按 4 倍放大重试，直到读满 want 行
 * 或触到文件开头 / 4MB 上限。这样单文件 2MB 但只看 100 行时，实际只读几 KB。
 */
function readTailLines(
  path: string,
  size: number,
  want: number
): { text: string; truncated: boolean } {
  let chunk = Math.min(size, Math.max(4096, want * BYTES_PER_LINE_GUESS))

  for (let attempt = 0; attempt < 5; attempt++) {
    const buf = Buffer.alloc(Math.min(chunk, size))
    let fh: number
    try {
      fh = openSync(path, 'r')
    } catch (e) {
      return { text: `[读取日志失败: ${String(e)}]`, truncated: false }
    }
    try {
      readSync(fh, buf, 0, buf.length, size - buf.length)
    } catch (e) {
      closeSync(fh)
      return { text: `[读取日志失败: ${String(e)}]`, truncated: false }
    }
    closeSync(fh)

    let text = buf.toString('utf8')
    // 不是从文件头开始读的，开头大概率是半截行，丢掉第一段
    const reachedBof = buf.length >= size
    if (!reachedBof) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }

    const lines = text ? text.split('\n') : []
    if (lines.length > want || reachedBof || chunk >= size) {
      const out = lines.slice(Math.max(0, lines.length - want)).join('\n')
      return { text: out, truncated: lines.length > want || !reachedBof }
    }
    if (chunk >= MAX_TAIL_BYTES) {
      return { text: lines.join('\n'), truncated: true }
    }
    chunk = Math.min(Math.max(chunk * 4, chunk + 65536), MAX_TAIL_BYTES, size)
  }
  return { text: '', truncated: true }
}
