/**
 * 日志流 —— tail/clear 实际读盘。
 */
import { EventBus } from './event-bus.js'
import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { join } from 'node:path'

const READ_BUFFER = 256 * 1024

export class LogStreamer {
  private bus: EventBus
  private logsDir: string

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

  tail(id: string, n: number): { text: string; truncated: boolean } {
    void n
    const path = join(this.logsDir, `${id}.log`)
    if (!existsSync(path)) return { text: '', truncated: false }
    try {
      const sz = statSync(path).size
      if (sz < 2 * 1024 * 1024) {
        return { text: readFileSync(path, 'utf8'), truncated: false }
      }
      const buf = Buffer.alloc(READ_BUFFER)
      const fh = openSync(path, 'r')
      try {
        readSync(fh, buf, 0, buf.length, sz - buf.length)
      } finally {
        closeSync(fh)
      }
      const text = buf.toString('utf8').replace(/^[\x00-\x1f\x7f]*/, '')
      return { text: '...[截断]...\n' + text, truncated: true }
    } catch (e) {
      return { text: `[读取日志失败: ${String(e)}]`, truncated: false }
    }
  }

  clear(id: string): void {
    const path = join(this.logsDir, `${id}.log`)
    try {
      writeFileSync(path, '')
    } catch {
      // ignore
    }
  }
}
