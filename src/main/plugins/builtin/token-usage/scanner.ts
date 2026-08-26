/**
 * 文件发现 + 增量扫描 v2
 *  - omp / zcode / codex / claude 走 jsonl 增量
 *  - opencode 走 SQLite 直查（db 文件 mtime 做 cursor key）
 */
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { parserForFile, sessionIdFromFile, readOpenCodeDb } from './parsers.js'
import {
  ensureUsageSchema,
  insertUsageBatch,
  getCursor,
  upsertCursor,
  resetCursor,
  resetAllCursors,
  type UsageRow,
  type Platform
} from './storage.js'
import { getDb } from '../../../services/db.js'

export interface ScannerStats {
  files_scanned: number
  rows_inserted: number
  last_scan_at: number
  by_agent: Record<Platform, number>
  errors: number
  opencode_messages: number
}

interface DiscoveredFile {
  path: string
  agent: Platform
  sessionId: string
}

export class UsageScanner extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | undefined
  private stats: ScannerStats = freshStats()
  private opencodeLastMtime: { path: string; mtime: number; count: number } | null = null

  start(): void {
    ensureUsageSchema()
    void this.scanAll()
    this.timer = setInterval(() => void this.scanAll(), 30_000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  getStats(): ScannerStats {
    return this.stats
  }

  async rescan(): Promise<ScannerStats> {
    resetAllCursors()
    this.stats = freshStats()
    this.opencodeLastMtime = null
    await this.scanAll()
    return this.stats
  }

  private async scanAll(): Promise<void> {
    let totalNew = 0
    try {
      const files = this.discoverJsonl()
      this.stats.files_scanned = files.length
      for (const f of files) {
        try {
          totalNew += await this.scanJsonlFile(f)
        } catch (e) {
          this.stats.errors++
          console.warn(`[token-usage] 扫描 ${f.path} 失败:`, e)
        }
      }
      try {
        totalNew += await this.scanOpenCode()
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 opencode.db 失败:', e)
      }
    } catch (e) {
      this.stats.errors++
      console.error('[token-usage] scanAll 异常:', e)
    }
    this.stats.rows_inserted += totalNew
    this.stats.last_scan_at = Date.now()
    this.emit('scanned', { files: this.stats.files_scanned, rows: totalNew })
  }

  private async scanJsonlFile(file: DiscoveredFile): Promise<number> {
    const st = statSync(file.path)
    const cursor = getCursor(file.path)
    if (
      cursor &&
      cursor.file_size === st.size &&
      cursor.file_mtime === Math.floor(st.mtimeMs)
    ) {
      return 0
    }
    if (cursor && cursor.file_mtime > Math.floor(st.mtimeMs)) {
      resetCursor(file.path)
    }
    const content = readFileSync(file.path, 'utf8')
    const lines = content.split('\n')
    const startFrom = cursor ? Math.min(cursor.lines_seen, lines.length) : 0
    const parser = parserForFile(file.agent, file.path)
    if (!parser) return 0
    const ctx = {
      agent: file.agent,
      filePath: file.path,
      sessionId: file.sessionId
    }
    const newRows: UsageRow[] = []
    for (let i = startFrom; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const row = parser(line, ctx)
      if (row) newRows.push(row)
    }
    if (newRows.length > 0) {
      insertUsageBatch(newRows)
      this.stats.by_agent[file.agent] =
        (this.stats.by_agent[file.agent] ?? 0) + newRows.length
    }
    upsertCursor(file.path, st.size, Math.floor(st.mtimeMs), lines.length)
    return newRows.length
  }

  private async scanOpenCode(): Promise<number> {
    const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
    if (!existsSync(dbPath)) return 0
    const st = statSync(dbPath)
    const mtime = Math.floor(st.mtimeMs)
    if (
      this.opencodeLastMtime &&
      this.opencodeLastMtime.path === dbPath &&
      this.opencodeLastMtime.mtime === mtime
    ) {
      return 0
    }
    const rows = readOpenCodeDb(dbPath)
    if (rows.length === 0) {
      this.opencodeLastMtime = { path: dbPath, mtime, count: 0 }
      return 0
    }
    // opencode 没有稳定 request_id；用全删全写简化去重
    getDb().prepare('DELETE FROM agent_usage WHERE agent = ?').run('opencode')
    const usageRows: UsageRow[] = rows.map((r) => ({
      agent: 'opencode',
      model: r.model,
      input_tokens: r.input,
      output_tokens: r.output,
      cached_tokens: r.cache_read + r.cache_write,
      cache_read_tokens: r.cache_read,
      cache_write_tokens: r.cache_write,
      cost_usd: r.cost,
      at: r.at,
      session_id: r.session_id,
      meta: null
    }))
    if (usageRows.length > 0) {
      insertUsageBatch(usageRows)
      this.stats.by_agent['opencode'] =
        (this.stats.by_agent['opencode'] ?? 0) + usageRows.length
    }
    this.opencodeLastMtime = { path: dbPath, mtime, count: rows.length }
    this.stats.opencode_messages = rows.length
    return usageRows.length
  }

  private discoverJsonl(): DiscoveredFile[] {
    const out: DiscoveredFile[] = []
    const home = homedir()

    const ompDir = join(home, '.omp', 'agent', 'sessions')
    if (existsSync(ompDir)) {
      walkJsonl(ompDir, (p) => {
        out.push({
          path: p,
          agent: 'omp',
          sessionId: sessionIdFromFile('omp', p)
        })
      })
    }

    const zcodeDir = join(home, '.zcode', 'cli', 'rollout')
    if (existsSync(zcodeDir)) {
      walkJsonl(zcodeDir, (p) => {
        out.push({
          path: p,
          agent: 'zcode',
          sessionId: sessionIdFromFile('zcode', p)
        })
      })
    }

    const codexDir = join(home, '.codex', 'sessions')
    if (existsSync(codexDir)) {
      walkJsonl(
        codexDir,
        (p) => {
          out.push({
            path: p,
            agent: 'codex',
            sessionId: sessionIdFromFile('codex', p)
          })
        },
        5
      )
    }

    const claudeDir = join(home, '.claude', 'projects')
    if (existsSync(claudeDir)) {
      walkJsonl(
        claudeDir,
        (p) => {
          out.push({
            path: p,
            agent: 'claude',
            sessionId: sessionIdFromFile('claude', p)
          })
        },
        5
      )
    }

    return out
  }
}

function walkJsonl(
  dir: string,
  onFile: (path: string) => void,
  depth = 0
): void {
  if (depth > 8) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkJsonl(full, onFile, depth + 1)
    } else if (st.isFile() && /\.jsonl$/.test(name) && !name.endsWith('.bak')) {
      onFile(full)
    }
  }
}

function freshStats(): ScannerStats {
  return {
    files_scanned: 0,
    rows_inserted: 0,
    last_scan_at: 0,
    by_agent: {
      omp: 0,
      zcode: 0,
      opencode: 0,
      codex: 0,
      claude: 0,
      unknown: 0
    },
    errors: 0,
    opencode_messages: 0
  }
}
