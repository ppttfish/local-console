/**
 * 文件发现 + 增量扫描 v2 — 异步不阻塞版
 *  - omp / zcode / codex / claude 走 jsonl 增量
 *  - opencode 走 SQLite 直查（db 文件 mtime 做 cursor key）
 *  - dsh 走 zstd 压缩 jsonl（无法按行增量，文件指纹变了全删全写）
 *
 * 关键优化：全链路异步化 + 周期性让出事件循环，避免 20s 同步扫描把主线程卡死
 */
import { existsSync, createReadStream, watch, type FSWatcher } from 'node:fs'
import { stat, readFile, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { parserForFile, sessionIdFromFile, readOpenCodeDb, parseDshSessionAsync, readZcodeDb, parseCodexSessionFromContent } from './parsers.js'
import { parseDshViaWorker, parseCodexViaWorker, parseCodexFileViaWorker, shutdownParseWorker } from '../../../workers/parse-worker-client.js'
import {
  ensureUsageSchema,
  insertUsageBatch,
  insertUsageBatchAsync,
  replaceUsageBySourceFile,
  replaceUsageBySourceFileAsync,
  replaceUsageByAgent,
  replaceUsageByAgentAsync,
  getCursor,
  upsertCursor,
  resetAllCursors,
  countLegacyRowsAsync,
  minAtForAgent,
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
  dsh_sessions: number
  opencode_flavor: 'openchamber' | 'opencode'
  rewrites: number
  last_rewrite: { file: string; rows: number; at: number } | null
  legacy_rows: number
  scanning: boolean
}

interface DiscoveredFile {
  path: string
  agent: Platform
  sessionId: string
}

function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

export class UsageScanner extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | undefined
  private watchers: FSWatcher[] = []
  private watchDebounce: ReturnType<typeof setTimeout> | null = null
  private stats: ScannerStats = freshStats()
  private opencodeLastMtime: { path: string; mtime: number; count: number } | null = null
  private dshFingerprint: string | null = null
  private zcodeDbLastMtime: { path: string; mtime: number } | null = null
  private scanQueue: Promise<void> = Promise.resolve()

  start(): void {
    if (this.timer) return
    ensureUsageSchema()
    void this.enqueueScan()
    // 极致：有 fs.watch 时轮询降为 5 分钟兜底，无 watch 时保持 30s
    const hasWatch = this.setupWatchers()
    this.timer = setInterval(() => void this.enqueueScan(), hasWatch ? 300_000 : 30_000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (this.watchDebounce) { clearTimeout(this.watchDebounce); this.watchDebounce = null }
    for (const w of this.watchers) try { w.close() } catch {}
    this.watchers = []
    try { shutdownParseWorker() } catch {}
  }

  private setupWatchers(): boolean {
    try {
      const home = homedir()
      const watchTargets = [
        join(home, '.omp', 'agent', 'sessions'),
        join(home, '.zcode', 'cli', 'rollout'),
        join(home, '.codex', 'sessions'),
        join(home, '.claude', 'projects'),
        join(home, '.dsh', 'sessions'),
        dirname(join(home, '.local', 'share', 'opencode', 'opencode.db')),
        dirname(join(home, '.zcode', 'cli', 'db', 'db.sqlite')),
      ]
      let ok = 0
      for (const p of watchTargets) {
        if (!existsSync(p)) continue
        try {
          const w = watch(p, { recursive: true }, () => this.scheduleWatchScan())
          this.watchers.push(w)
          ok++
        } catch {}
      }
      return ok > 0
    } catch { return false }
  }

  private scheduleWatchScan(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    // 防抖 2s：单次会话写入会触发多次 change/rename，合并为一次扫描
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null
      void this.enqueueScan()
    }, 2000)
  }

  getStats(): ScannerStats {
    return this.stats
  }

  private enqueueScan(force = false): Promise<void> {
    const next = this.scanQueue.then(() => this.runScanAll(force))
    this.scanQueue = next.catch(() => undefined)
    return next
  }

  async rescan(): Promise<ScannerStats> {
    resetAllCursors()
    getDb().prepare('DELETE FROM agent_usage').run()
    this.stats = freshStats()
    this.opencodeLastMtime = null
    this.dshFingerprint = null
    this.zcodeDbLastMtime = null
    await this.enqueueScan(true)
    return this.stats
  }

  startRescan(): { started: boolean } {
    void this.rescan().catch((e) => {
      this.stats.errors++
      console.error('[token-usage] rescan 失败:', e)
    })
    return { started: true }
  }

  private async runScanAll(force = false): Promise<void> {
    let totalNew = 0
    this.stats.scanning = true
    try {
      const files = await this.discoverJsonl()
      this.stats.files_scanned = files.length
      let processed = 0
      for (const f of files) {
        try {
          totalNew += await this.scanJsonlFile(f, force)
        } catch (e) {
          this.stats.errors++
          console.warn(`[token-usage] 扫描 ${f.path} 失败:`, e)
        }
        processed++
        // 每 8 个文件让出一次，避免连续大文件解析饿死后续 IPC
        if (processed % 8 === 0) await yieldToLoop()
      }
      try {
        totalNew += await this.scanZcodeDb(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 zcode db 失败:', e)
      }
      await yieldToLoop()
      try {
        totalNew += await this.scanOpenCode(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 opencode.db 失败:', e)
      }
      await yieldToLoop()
      try {
        totalNew += await this.scanDsh(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 dsh sessions 失败:', e)
      }
    } catch (e) {
      this.stats.errors++
      console.error('[token-usage] scanAll 异常:', e)
    }
    this.stats.scanning = false
    this.stats.rows_inserted += totalNew
    this.stats.last_scan_at = Date.now()
    try {
      this.stats.legacy_rows = await countLegacyRowsAsync()
    } catch {
      this.stats.legacy_rows = 0
    }
    this.emit('scanned', { files: this.stats.files_scanned, rows: totalNew })
  }

  private async scanJsonlFile(file: DiscoveredFile, force = false): Promise<number> {
    let st: { size: number; mtimeMs: number }
    try {
      const s = await stat(file.path)
      st = { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return 0
    }
    const cursor = getCursor(file.path)
    if (
      !force &&
      cursor &&
      cursor.head_hash !== null &&
      cursor.file_size === st.size &&
      cursor.file_mtime === Math.floor(st.mtimeMs)
    ) {
      return 0
    }

    const LARGE_THRESHOLD = 0
    if (st.size > LARGE_THRESHOLD) {
      // 极致：大文件流式，避免 50MB+ readFile 入内存
      const stats = await streamFileStats(file.path)
      const linesCount = stats.lines
      const fingerprintFull = fingerprintFromStream(stats)
      if (file.agent === 'codex') {
        const alreadyDone = !force && cursor && cursor.head_hash !== null && cursor.file_size === st.size && cursor.file_mtime === Math.floor(st.mtimeMs)
        if (alreadyDone) return 0
        // codex 大文件：Worker 内直接读盘，主线程流式算指纹避免重复大内存
        let codexPrefixFp: string | null = null
        if (cursor && cursor.head_hash !== null && cursor.lines_seen > 0) {
          codexPrefixFp = await streamFingerprintUpTo(file.path, cursor.lines_seen)
        }
        const codexRows = await parseCodexFileViaWorker(file.path, file.sessionId, () => parseCodexSessionFromContent('', file.sessionId)) as ReturnType<typeof parseCodexSessionFromContent>
        const rebuilt = !!cursor && (linesCount < (cursor.lines_seen ?? 0) || (codexPrefixFp !== null && cursor.head_hash !== null && cursor.head_hash !== codexPrefixFp))
        // 简化：大文件 codex 直接按 Worker 返回全量重建
        const toInsert: UsageRow[] = (Array.isArray(codexRows) ? codexRows : []).map(r => ({ ...r, source_file: file.path } as UsageRow))
        // 若 Worker 回退空（文件不存在），尝试用流式兜底已在 Worker 内处理
        await replaceUsageBySourceFileAsync(file.path, file.agent, file.sessionId, toInsert)
        if (toInsert.length > 0) this.stats.by_agent[file.agent] = (this.stats.by_agent[file.agent] ?? 0) + toInsert.length
        if (rebuilt) {
          this.stats.rewrites++
          this.stats.last_rewrite = { file: file.path, rows: toInsert.length, at: Date.now() }
        }
        upsertCursor(file.path, st.size, Math.floor(st.mtimeMs), linesCount, fingerprintFull)
        await yieldToLoop()
        return 0
      }
      // 非 codex 大文件：流式两阶段（先算重建，再流式解析增量）
      let fingerprintPrefix: string | null = null
      if (cursor && cursor.head_hash !== null && cursor.lines_seen > 0) {
        fingerprintPrefix = await streamFingerprintUpTo(file.path, cursor.lines_seen)
      }
      let startFrom = 0
      let rebuilt = false
      if (cursor && !force) {
        const shrunk = linesCount < cursor.lines_seen
        const drifted = fingerprintPrefix !== null && cursor.head_hash !== null && cursor.head_hash !== fingerprintPrefix
        if (!shrunk && !drifted) startFrom = cursor.lines_seen
        else rebuilt = true
      }
      const parser = parserForFile(file.agent, file.path)
      if (!parser) return 0
      const ctx = { agent: file.agent, filePath: file.path, sessionId: file.sessionId }
      const newRows = await parseLargeFileStreamed(file.path, parser, ctx, startFrom)
      if (rebuilt || force) {
        await replaceUsageBySourceFileAsync(file.path, file.agent, file.sessionId, newRows)
        if (newRows.length > 0) this.stats.by_agent[file.agent] = (this.stats.by_agent[file.agent] ?? 0) + newRows.length
      } else if (newRows.length > 0) {
        await insertUsageBatchAsync(newRows)
        this.stats.by_agent[file.agent] = (this.stats.by_agent[file.agent] ?? 0) + newRows.length
      }
      if (rebuilt) {
        this.stats.rewrites++
        this.stats.last_rewrite = { file: file.path, rows: newRows.length, at: Date.now() }
      }
      upsertCursor(file.path, st.size, Math.floor(st.mtimeMs), linesCount, fingerprintFull)
      if (newRows.length > 3000) await yieldToLoop()
      return rebuilt ? 0 : newRows.length
    }

    let content: string
    try {
      content = await readFile(file.path, 'utf8')
    } catch {
      return 0
    }
    // 大文件读取后让出一次
    if (content.length > 512 * 1024) await yieldToLoop()

    const lines = content.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    if (file.agent === 'codex') {
      const alreadyDone = !force &&
        cursor! &&
        cursor!.head_hash !== null &&
        cursor!.file_size === st.size &&
        cursor!.file_mtime === Math.floor(st.mtimeMs)
      if (alreadyDone) return 0
      // codex 走整文件有状态解析，直接用已读的 content 避免二次 readFileSync
      // 极致：搬入 Worker，主线程零 CPU
      const codexRows = await parseCodexViaWorker(content, file.sessionId, () => parseCodexSessionFromContent(content, file.sessionId)) as ReturnType<typeof parseCodexSessionFromContent>
      const toInsert: UsageRow[] = codexRows.map(r => ({ ...r, source_file: file.path } as UsageRow))
      await replaceUsageBySourceFileAsync(file.path, file.agent, file.sessionId, toInsert)
      if (toInsert.length > 0) {
        this.stats.by_agent[file.agent] =
          (this.stats.by_agent[file.agent] ?? 0) + toInsert.length
      }
      const rebuilt = !!cursor && (lines.length < (cursor!.lines_seen ?? 0) || (cursor!.head_hash !== null && cursor!.head_hash !== headFingerprint(lines, cursor!.lines_seen ?? 0)))
      if (rebuilt) {
        this.stats.rewrites++
        this.stats.last_rewrite = { file: file.path, rows: toInsert.length, at: Date.now() }
        console.warn(
          `[token-usage] 检测到文件被重写，已整文件重建：${file.path}` +
            `（游标 ${cursor?.lines_seen ?? 0} 行 → 现有 ${lines.length} 行，重建出 ${toInsert.length} 行）`
        )
      }
      upsertCursor(file.path, st.size, Math.floor(st.mtimeMs), lines.length, headFingerprint(lines, lines.length))
      // codex 重建后让出，避免连续多个 codex 文件串行阻塞
      await yieldToLoop()
      return 0
    }

    const parser = parserForFile(file.agent, file.path)
    if (!parser) return 0

    let startFrom = 0
    let rebuilt = false
    if (cursor && !force) {
      const shrunk = lines.length < cursor!.lines_seen
      const drifted =
        cursor!.head_hash !== null &&
        cursor!.head_hash !== headFingerprint(lines, cursor!.lines_seen ?? 0)
      if (!shrunk && !drifted) {
        startFrom = cursor!.lines_seen
      } else {
        rebuilt = true
      }
    }

    const ctx = {
      agent: file.agent,
      filePath: file.path,
      sessionId: file.sessionId
    }
    const newRows: UsageRow[] = []
    // 分批解析，每 2000 行让出一次，避免超大文件一次把事件循环占满
    const BATCH = 2000
    for (let i = startFrom; i < lines.length; i++) {
      const line = lines[i]!
      if (!line) continue
      const row = parser!(line, ctx)
      if (row) newRows.push({ ...row, source_file: file.path } as UsageRow)
      if ((i - startFrom) % BATCH === 0 && i !== startFrom) {
        await yieldToLoop()
      }
    }
    if (rebuilt || force) {
      await replaceUsageBySourceFileAsync(file.path, file.agent, file.sessionId, newRows)
      if (newRows.length > 0) {
        this.stats.by_agent[file.agent] =
          (this.stats.by_agent[file.agent] ?? 0) + newRows.length
      }
    } else if (newRows.length > 0) {
      await insertUsageBatchAsync(newRows)
      this.stats.by_agent[file.agent] =
        (this.stats.by_agent[file.agent] ?? 0) + newRows.length
    }
    if (rebuilt) {
      this.stats.rewrites++
      this.stats.last_rewrite = {
        file: file.path,
        rows: newRows.length,
        at: Date.now()
      }
      console.warn(
        `[token-usage] 检测到文件被重写，已整文件重建：${file.path}` +
          `（游标 ${cursor?.lines_seen ?? 0} 行 → 现有 ${lines.length} 行，重建出 ${newRows.length} 行）`
      )
    }
    upsertCursor(
      file.path,
      st.size,
      Math.floor(st.mtimeMs),
      lines.length,
      headFingerprint(lines, lines.length)
    )
    if (newRows.length > 3000) await yieldToLoop()
    return rebuilt ? 0 : newRows.length
  }

  private async scanZcodeDb(force = false): Promise<number> {
    const dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
    if (!existsSync(dbPath)) return 0
    let mtime: number
    try {
      const s = await stat(dbPath)
      mtime = Math.floor(s.mtimeMs)
    } catch { return 0 }
    if (
      !force &&
      this.zcodeDbLastMtime &&
      this.zcodeDbLastMtime.path === dbPath &&
      this.zcodeDbLastMtime.mtime === mtime
    ) {
      return 0
    }
    // readZcodeDb 会同步开 better-sqlite3 读外部 sqlite，I/O 虽短但仍让出
    await yieldToLoop()
    const rows = readZcodeDb(dbPath)
    if (rows.length === 0) {
      this.zcodeDbLastMtime = { path: dbPath, mtime }
      return 0
    }
    const usageRows: UsageRow[] = rows.map((r) => ({
      agent: 'zcode',
      model: r.model,
      input_tokens: r.input,
      output_tokens: r.output,
      cached_tokens: r.cache_read + r.cache_write,
      cache_read_tokens: r.cache_read,
      cache_write_tokens: r.cache_write,
      cost_usd: r.cost,
      at: r.at,
      session_id: r.session_id,
      meta: null,
      source_file: dbPath
    }))
    await replaceUsageByAgentAsync('zcode', usageRows)
    this.stats.by_agent['zcode'] =
      (this.stats.by_agent['zcode'] ?? 0) + usageRows.length
    this.zcodeDbLastMtime = { path: dbPath, mtime }
    await yieldToLoop()
    return usageRows.length
  }

  private async scanOpenCode(force = false): Promise<number> {
    const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
    if (!existsSync(dbPath)) return 0
    let mtime: number
    try {
      const s = await stat(dbPath)
      mtime = Math.floor(s.mtimeMs)
    } catch { return 0 }
    if (
      !force &&
      this.opencodeLastMtime &&
      this.opencodeLastMtime.path === dbPath &&
      this.opencodeLastMtime.mtime === mtime
    ) {
      return 0
    }
    await yieldToLoop()
    const rows = readOpenCodeDb(dbPath, minAtForAgent('opencode'))
    if (rows.length === 0) {
      this.opencodeLastMtime = { path: dbPath, mtime, count: 0 }
      return 0
    }
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
      meta: null,
      source_file: dbPath
    }))
    await replaceUsageByAgentAsync('opencode', usageRows)
    this.stats.by_agent['opencode'] =
      (this.stats.by_agent['opencode'] ?? 0) + usageRows.length
    this.opencodeLastMtime = { path: dbPath, mtime, count: rows.length }
    this.stats.opencode_messages = rows.length
    await yieldToLoop()
    return usageRows.length
  }

  private async scanDsh(force = false): Promise<number> {
    const root = join(homedir(), '.dsh', 'sessions')
    if (!existsSync(root)) return 0
    const files: Array<{ path: string; sessionId: string }> = []
    await walkJsonlAsync(
      root,
      (p) => {
        files.push({ path: p, sessionId: sessionIdFromFile('dsh', p) })
      },
      0,
      /\.jsonl\.zstd$/
    )
    if (files.length === 0) return 0
    const parts: string[] = []
    let idx = 0
    for (const f of files) {
      try {
        const s = await stat(f.path)
        parts.push(`${f.path}:${s.size}:${Math.floor(s.mtimeMs)}`)
      } catch {}
      if (idx++ % 20 === 0) await yieldToLoop()
    }
    const fingerprint = parts.sort().join('|')
    if (!force && this.dshFingerprint === fingerprint) return 0

    const all: UsageRow[] = []
    const seen = new Set<string>()
    for (const f of files) {
      try {
        const rows = await parseDshViaWorker(
          f.path,
          f.sessionId,
          () => parseDshSessionAsync(f.path, f.sessionId)
        ) as Array<import('./parsers.js').ParsedUsageRow & { seq?: number }>
        for (const r of rows) {
          const key = `${r.seq ?? ''}@${r.at}`
          if (seen.has(key)) continue
          seen.add(key)
          const { seq, ...row } = r
          all.push({ ...row, source_file: f.path } as UsageRow)
        }
      } catch (e) {
        this.stats.errors++
        console.warn(`[token-usage] 解析 dsh 会话 ${f.path} 失败:`, e)
      }
      await yieldToLoop()
    }
    await replaceUsageByAgentAsync('dsh', all)
    this.dshFingerprint = fingerprint
    this.stats.by_agent['dsh'] = (this.stats.by_agent['dsh'] ?? 0) + all.length
    this.stats.dsh_sessions = files.length
    return all.length
  }

  private async discoverJsonl(): Promise<DiscoveredFile[]> {
    const out: DiscoveredFile[] = []
    const home = homedir()

    const ompDir = join(home, '.omp', 'agent', 'sessions')
    if (existsSync(ompDir)) {
      await walkJsonlAsync(ompDir, (p) => {
        out.push({
          path: p,
          agent: 'omp',
          sessionId: sessionIdFromFile('omp', p)
        })
      })
    }

    const zcodeDir = join(home, '.zcode', 'cli', 'rollout')
    if (existsSync(zcodeDir)) {
      await walkJsonlAsync(zcodeDir, (p) => {
        out.push({
          path: p,
          agent: 'zcode',
          sessionId: sessionIdFromFile('zcode', p)
        })
      })
    }

    const codexDir = join(home, '.codex', 'sessions')
    if (existsSync(codexDir)) {
      await walkJsonlAsync(
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
      await walkJsonlAsync(
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

export const usageScanner = new UsageScanner()

async function walkJsonlAsync(
  dir: string,
  onFile: (path: string) => void,
  depth = 0,
  match: RegExp = /\.jsonl$/
): Promise<void> {
  if (depth > 8) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  // 批量 stat + 递归，带让出
  let count = 0
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      await walkJsonlAsync(full, onFile, depth + 1, match)
    } else if (st.isFile() && match.test(name) && !name.endsWith('.bak')) {
      onFile(full)
    }
    if (++count % 100 === 0) await yieldToLoop()
  }
}

// 极致：流式统计大文件（>2MB）避免整文件 readFile 入内存
// 单次流式遍历得到 linesCount / 总字符 / 首行头 / 末行尾，进而算 headFingerprint
async function streamFileStats(filePath: string): Promise<{ lines: number; chars: number; head: string; tail: string }> {
  return new Promise((resolve, reject) => {
    let lines = 0
    let chars = 0
    let head = ''
    let tail = ''
    let first = true
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line: string) => {
      if (first) { head = line.slice(0, 128); first = false }
      tail = line.slice(-128)
      chars += line.length
      lines++
    })
    rl.on('close', () => resolve({ lines, chars, head, tail }))
    rl.on('error', reject)
    stream.on('error', reject)
  })
}

async function streamFingerprintUpTo(filePath: string, upto: number): Promise<string> {
  if (upto <= 0) return `0:0:${shortHash('')}:${shortHash('')}`
  return new Promise((resolve, reject) => {
    let n = 0
    let chars = 0
    let head = ''
    let tail = ''
    let first = true
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line: string) => {
      if (n >= upto) { rl.close(); stream.destroy(); return }
      if (first) { head = line.slice(0, 128); first = false }
      tail = line.slice(-128)
      chars += line.length
      n++
      if (n >= upto) { rl.close(); stream.destroy() }
    })
    const done = () => resolve(`${n}:${chars}:${shortHash(head)}:${shortHash(tail)}`)
    rl.on('close', done)
    rl.on('error', reject)
    stream.on('error', reject)
  })
}

function fingerprintFromStream(stats: { lines: number; chars: number; head: string; tail: string }): string {
  return `${stats.lines}:${stats.chars}:${shortHash(stats.head)}:${shortHash(stats.tail)}`
}

// 大文件流式解析：逐行 readline，BATCH 间让出，避免 50MB 文件一次性入内存
async function parseLargeFileStreamed(
  filePath: string,
  parser: ReturnType<typeof parserForFile>,
  ctx: { agent: Platform; filePath: string; sessionId: string },
  startFrom: number
): Promise<import('./storage.js').UsageRow[]> {
  if (!parser) return []
  const rows: import('./storage.js').UsageRow[] = []
  let idx = 0
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (idx >= startFrom && line) {
      const row = parser(line, ctx)
      if (row) rows.push({ ...row, source_file: filePath } as import('./storage.js').UsageRow)
    }
    idx++
    if (idx % 2000 === 0) await yieldToLoop()
  }
  return rows
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
      dsh: 0,
      unknown: 0
    },
    errors: 0,
    opencode_messages: 0,
    dsh_sessions: 0,
    opencode_flavor: detectOpenCodeFlavor(),
    rewrites: 0,
    last_rewrite: null,
    legacy_rows: 0,
    scanning: false
  }
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function headFingerprint(lines: string[], upto: number): string {
  const n = Math.min(upto, lines.length)
  let chars = 0
  for (let i = 0; i < n; i++) chars += lines[i]!.length
  const head = lines[0]?.slice(0, 128) ?? ''
  const tail = n > 0 ? (lines[n - 1] ?? '').slice(-128) : ''
  return `${n}:${chars}:${shortHash(head)}:${shortHash(tail)}`
}

function detectOpenCodeFlavor(): 'openchamber' | 'opencode' {
  const home = homedir()
  try {
    if (statSync(join(home, '.config', 'openchamber')).isDirectory()) {
      return 'openchamber'
    }
  } catch {}
  try {
    if (existsSync(join(home, '.local', 'share', 'opencode', 'auth.json.openchamber.backup'))) {
      return 'openchamber'
    }
  } catch {}
  return 'opencode'
}
