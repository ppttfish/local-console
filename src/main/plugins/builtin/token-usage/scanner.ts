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
import { parserForFile, sessionIdFromFile, readOpenCodeDb, readOpenCodeDbAfter, maxOpenCodeRowidUpTo, parseDshSessionAsync, readZcodeDb, parseCodexSession, parseCodexSessionFromContent } from './parsers.js'
import { dedupeDshRows } from './dsh-parse.js'
import { parseDshViaWorker, parseCodexViaWorker, parseCodexFileViaWorker, shutdownParseWorker } from '../../../workers/parse-worker-client.js'
import { listDiscoveredSources, listUnknownAgents } from './source-registry.js'
import {
  ensureUsageSchema,
  insertUsageBatchAsync,
  replaceUsageBySourceFileAsync,
  replaceUsageByAgentAsync,
  replaceUsageBySessionWindowsAsync,
  getCursor,
  upsertCursor,
  resetAllCursors,
  countLegacyRowsAsync,
  maxAtForAgent,
  countRowsForAgent,
  type SessionWindow,
  type UsageRow,
  type Platform
} from './storage.js'
import { getDb } from '../../../services/db.js'

/** 超过该大小的 jsonl 走流式大文件路径；流式有固定开销，小文件整读反而更快 */
const LARGE_THRESHOLD = 5 * 1024 * 1024

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
  private watchFirstEventAt: number | null = null
  private stats: ScannerStats = freshStats()
  private opencodeLastMtime: { path: string; mtime: number; count: number } | null = null
  private zcodeDbLastMtime: { path: string; mtime: number } | null = null
  private scanQueue: Promise<void> = Promise.resolve()
  private channelsLogged = false
  /** 本轮扫描里真正被解析（游标未命中）的文件，用于性能诊断 */
  private parsedFiles: string[] = []

  start(): void {
    if (this.timer) return
    ensureUsageSchema()
    this.logChannels()
    void this.enqueueScan()
    // 极致：有 fs.watch 时轮询降为 5 分钟兜底，无 watch 时保持 30s
    const hasWatch = this.setupWatchers()
    this.timer = setInterval(() => void this.enqueueScan(), hasWatch ? 300_000 : 30_000)
  }

  /**
   * 把「扫到了哪些渠道 / 哪些目录没被识别」写进启动日志。
   * README 一直承诺有这个提醒，但代码里从没调用过 —— 国产 agent（WorkBuddy、
   * Qoder、Trae、Kimi Code…）数据进不来时用户完全无感知。
   */
  private logChannels(): void {
    if (this.channelsLogged) return
    this.channelsLogged = true
    try {
      const found = listDiscoveredSources()
      console.info(
        `[token-usage] 已识别渠道 ${found.length} 个：` +
          found.map((s) => `${s.displayName}(${s.agent})`).join(' / ')
      )
      const unknown = listUnknownAgents()
      if (unknown.length > 0) {
        console.info(
          `[token-usage] 未识别的 agent 目录（不会进统计）：` +
            unknown.map((u) => u.name).join(', ') +
            '；需要在 source-registry.ts + parsers.ts 里加适配'
        )
      }
    } catch (e) {
      console.warn('[token-usage] 渠道探测失败:', e)
    }
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
      // 监听目标全部来自 source-registry（dataSubpath），加新 agent 不用改这里。
      // 注意别去 watch 整个 agent 根目录：.workbuddy/daemon.log 之类的日志每秒都在写，
      // recursive watch 会被噪音拖着不停触发全量扫描。
      const targets = new Set<string>()
      for (const s of listDiscoveredSources()) {
        targets.add(join(home, s.dataSubpath ?? s.homeSubpath))
      }
      // zcode 的用量权威来源是 db.sqlite，单独挂一个监听
      targets.add(join(home, '.zcode', 'cli', 'db'))
      targets.add(dirname(join(home, '.local', 'share', 'opencode', 'opencode.db')))

      let ok = 0
      for (const p of targets) {
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
    // 防抖 2s：单次会话写入会触发多次 change/rename，合并为一次扫描。
    // 但 agent 活跃时事件是连绵不断的，纯防抖会让扫描被无限推迟（一直不更新），
    // 所以再加一个 15s 的最长等待：超过就直接扫。
    const now = Date.now()
    if (this.watchFirstEventAt === null) this.watchFirstEventAt = now
    const waited = now - this.watchFirstEventAt
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    const delay = waited > 15000 ? 0 : 2000
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null
      this.watchFirstEventAt = null
      void this.enqueueScan()
    }, delay)
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
    const scanStartedAt = Date.now()
    const phase = { jsonl: 0, zcode: 0, opencode: 0, dsh: 0 }
    const mark = () => Date.now()
    this.stats.scanning = true
    try {
      let t = mark()
      const files = await this.discoverJsonl()
      this.stats.files_scanned = files.length
      let processed = 0
      const slow: Array<{ p: string; ms: number }> = []
      this.parsedFiles = []
      for (const f of files) {
        const fileStart = Date.now()
        try {
          totalNew += await this.scanJsonlFile(f, force)
        } catch (e) {
          this.stats.errors++
          console.warn(`[token-usage] 扫描 ${f.path} 失败:`, e)
        }
        const cost = Date.now() - fileStart
        if (cost > 300) slow.push({ p: f.path, ms: cost })
        processed++
        // 每 8 个文件让出一次，避免连续大文件解析饿死后续 IPC
        if (processed % 8 === 0) await yieldToLoop()
      }
      phase.jsonl = mark() - t
      if (phase.jsonl > 2000) {
        slow.sort((a, b) => b.ms - a.ms)
        console.info(
          `[token-usage] jsonl 解析了 ${this.parsedFiles.length}/${files.length} 个文件`,
          slow.length > 0
            ? `慢文件: ${slow.slice(0, 5).map((s) => `${s.ms}ms ${s.p}`).join(' | ')}`
            : `样例: ${this.parsedFiles.slice(0, 3).join(' , ')}`
        )
      }
      t = mark()
      try {
        totalNew += await this.scanZcodeDb(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 zcode db 失败:', e)
      }
      phase.zcode = mark() - t
      await yieldToLoop()
      t = mark()
      try {
        totalNew += await this.scanOpenCode(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 opencode.db 失败:', e)
      }
      phase.opencode = mark() - t
      await yieldToLoop()
      t = mark()
      try {
        totalNew += await this.scanDsh(force)
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 dsh sessions 失败:', e)
      }
      phase.dsh = mark() - t
    } catch (e) {
      this.stats.errors++
      console.error('[token-usage] scanAll 异常:', e)
    }
    this.stats.scanning = false
    this.stats.rows_inserted += totalNew
    this.stats.last_scan_at = Date.now()
    // 扫描耗时进日志：卡顿排查时一眼能看出是「谁」慢（DSH 全量解压 / opencode 全表读…）
    const totalMs = Date.now() - scanStartedAt
    if (force || totalMs > 3000) {
      console.info(
        `[token-usage] 扫描完成 ${totalMs}ms（文件 ${this.stats.files_scanned}，新增行 ${totalNew}${force ? '，强制全量' : ''}）` +
          ` 分阶段: jsonl=${phase.jsonl}ms zcode=${phase.zcode}ms opencode=${phase.opencode}ms dsh=${phase.dsh}ms`
      )
    }
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
    this.parsedFiles.push(file.path)

    if (st.size > LARGE_THRESHOLD) {
      // 大文件流式，避免 50MB+ readFile 入内存
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
        // 兜底必须按路径重新读盘解析：解析空串会返回 0 行，随后按空「删旧+插新」
        // 会把该文件已入库的行清光（打包态 worker 起不来时曾致 codex 有史 0 行）
        const codexRows = await parseCodexFileViaWorker(file.path, file.sessionId, () => parseCodexSession(file.path, file.sessionId)) as ReturnType<typeof parseCodexSessionFromContent>
        const rebuilt = !!cursor && (linesCount < (cursor.lines_seen ?? 0) || (codexPrefixFp !== null && cursor.head_hash !== null && cursor.head_hash !== codexPrefixFp))
        // 简化：大文件 codex 直接按 Worker 返回全量重建
        const toInsert: UsageRow[] = (Array.isArray(codexRows) ? codexRows : []).map(r => ({ ...r, source_file: file.path } as UsageRow))
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

  /**
   * opencode.db 扫描 —— rowid 游标增量。
   *
   * 本机 opencode.db 已涨到 16GB（2.3 万行 message，平均每行几百 KB）。老实现每次
   * mtime 变化都 `WHERE time_created >= MIN(已入库 at)` + 全表 data 重读 + JSON.parse
   * （实测 4.7s + 3.6s）+ replaceUsageByAgent 全删全写 2 万行，且 opencode 活跃时
   * 这个循环几乎不停。现在：rowid 是主键，`rowid > 游标` 只读新增行；入库用
   * 「按会话窗口删旧+插新」，多进程并发也幂等。
   */
  private async scanOpenCode(force = false): Promise<number> {
    const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
    if (!existsSync(dbPath)) return 0
    let mtime: number
    try {
      const s = await stat(dbPath)
      mtime = Math.floor(s.mtimeMs)
    } catch { return 0 }
    const cursorRow = getCursor(dbPath)
    if (
      !force &&
      this.opencodeLastMtime &&
      this.opencodeLastMtime.path === dbPath &&
      this.opencodeLastMtime.mtime === mtime
    ) {
      return 0
    }
    await yieldToLoop()

    // 首次入仓：如果库里已经有 opencode 数据，把游标种在「已入库最新时间」对应的
    // 最大 rowid 上（走覆盖索引，毫秒级），避免为了对齐而把 16GB 重读一遍
    let afterRowid = cursorRow?.lines_seen ?? 0
    if (!cursorRow && !force) {
      const maxAt = maxAtForAgent('opencode')
      if (maxAt > 0) {
        afterRowid = maxOpenCodeRowidUpTo(dbPath, maxAt)
        if (afterRowid > 0) {
          console.info(
            `[token-usage] opencode 首次增量扫描：游标种子 rowid=${afterRowid}（跳过全量 16GB 重读）`
          )
        }
      }
    }

    const read = force
      ? { rows: readOpenCodeDb(dbPath, 0), maxRowid: 0 }
      : readOpenCodeDbAfter(dbPath, afterRowid)
    const rows = read.rows
    this.opencodeLastMtime = { path: dbPath, mtime, count: rows.length }
    if (rows.length > 0 || force) {
      console.info(
        `[token-usage] opencode ${force ? '全量' : '增量'}读取 ${rows.length} 条（游标 ${afterRowid} → ${read.maxRowid || '全量'}）`
      )
    }

    if (rows.length === 0) {
      // 一条新消息都没有：游标必须原地不动。
      // （曾经这里写成「把游标推到本次读到的 maxRowid」——没读到行时 maxRowid=0，
      //   等于把游标清零，下一次扫描又把整张 16GB 表重读一遍。）
      if (!cursorRow) {
        upsertCursor(
          dbPath,
          0,
          mtime,
          force ? maxOpenCodeRowidUpTo(dbPath, Date.now()) : afterRowid,
          'opencode'
        )
      }
      this.stats.opencode_messages = countRowsForAgent('opencode')
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

    if (force) {
      // 显式重扫：全量重建，游标随后指向当前最大 rowid（否则下一次扫描又要把
      // 16GB 重读一遍）
      await replaceUsageByAgentAsync('opencode', usageRows)
      upsertCursor(dbPath, 0, mtime, maxOpenCodeRowidUpTo(dbPath, Date.now()), 'opencode')
    } else {
      // 按会话窗口删旧+插新：同一会话在本次新增区间内的旧行清掉再写，
      // 并发扫描器重复执行结果一致
      const windows = new Map<string, number>()
      for (const r of usageRows) {
        const prev = windows.get(r.session_id)
        if (prev === undefined || r.at < prev) windows.set(r.session_id, r.at)
      }
      const list: SessionWindow[] = [...windows.entries()].map(([sessionId, fromAt]) => ({
        sessionId,
        fromAt
      }))
      await replaceUsageBySessionWindowsAsync('opencode', list, usageRows)
      upsertCursor(dbPath, 0, mtime, read.maxRowid, 'opencode')
    }
    this.stats.by_agent['opencode'] =
      (this.stats.by_agent['opencode'] ?? 0) + usageRows.length
    this.stats.opencode_messages = countRowsForAgent('opencode')
    await yieldToLoop()
    return usageRows.length
  }

  /**
   * DSH 会话扫描 —— 按文件增量。
   *
   * 老实现每次指纹变化（任何会话文件被写）就把全部 43 个会话重新解压解析一遍：
   * 23.6MB zstd → 75MB 文本 → 5.2 万行 JSON，单线程实测 25.5 秒，而会话活跃期间
   * 指纹每 2 秒就变一次 —— 这是「卡死」最粗的那根管子。
   * 现在每个文件有自己的游标（size+mtime），只重解压真正变了的那个文件。
   */
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

    this.stats.dsh_sessions = files.length
    let total = 0
    let idx = 0
    const dshStartedAt = Date.now()
    let reparsed = 0
    for (const f of files) {
      try {
        const s = await stat(f.path)
        const size = s.size
        const mtime = Math.floor(s.mtimeMs)
        const cursor = getCursor(f.path)
        const unchanged =
          !force &&
          !!cursor &&
          cursor.head_hash !== null &&
          cursor.file_size === size &&
          cursor.file_mtime === mtime
        if (!unchanged) {
          const rows = await parseDshViaWorker(
            f.path,
            f.sessionId,
            () => parseDshSessionAsync(f.path, f.sessionId)
          )
          const parsed = dedupeDshRows(
            (Array.isArray(rows) ? rows : []) as Array<
              import('./dsh-parse.js').DshUsageRow
            >
          )
          const withSource: UsageRow[] = parsed.map((r) => {
            const { seq, ...rest } = r
            void seq
            return { ...rest, source_file: f.path } as UsageRow
          })
          // 解析抛错（压缩流损坏/读取失败）时 parser 会 throw → 外层 catch；
          // 真解析成功但 0 行时才按空重建（会话确实没有计费调用）
          await replaceUsageBySourceFileAsync(f.path, 'dsh', f.sessionId, withSource)
          upsertCursor(f.path, size, mtime, withSource.length, `dsh:${size}:${mtime}`)
          total += withSource.length
          reparsed++
          this.stats.by_agent['dsh'] =
            (this.stats.by_agent['dsh'] ?? 0) + withSource.length
        }
      } catch (e) {
        this.stats.errors++
        console.warn(`[token-usage] 解析 dsh 会话 ${f.path} 失败（保留已入库数据）:`, e)
      }
      if (idx++ % 8 === 0) await yieldToLoop()
    }
    if (reparsed > 0) {
      console.info(
        `[token-usage] dsh 重解压 ${reparsed}/${files.length} 个会话，用时 ${Date.now() - dshStartedAt}ms，行 ${total}`
      )
    }
    return total
  }

  private async discoverJsonl(): Promise<DiscoveredFile[]> {
    const out: DiscoveredFile[] = []
    const home = homedir()
    // 渠道表驱动：SOURCES 里类型为 jsonl 的全部自动遍历，
    // 不再为每个 agent 手写一段（之前加 agent 必须同时改 scanner）
    for (const s of listDiscoveredSources()) {
      if (s.type !== 'jsonl') continue
      // 扫描根目录 = dataSubpath（精确到会话目录），绝不能退化成 homeSubpath：
      // ~/.codex、~/.workbuddy 这类根目录下有 1.6 万 / 4.4 万个无关文件
      const dir = join(home, s.dataSubpath ?? s.homeSubpath)
      if (!existsSync(dir)) continue
      await walkJsonlAsync(
        dir,
        (p) => {
          out.push({
            path: p,
            agent: s.agent,
            sessionId: sessionIdFromFile(s.agent, p)
          })
        },
        0,
        s.filePattern ?? /\.jsonl$/,
        s.maxDepth ?? 8
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
  match: RegExp = /\.jsonl$/,
  maxDepth = 8
): Promise<void> {
  if (depth > maxDepth) return
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
      await walkJsonlAsync(full, onFile, depth + 1, match, maxDepth)
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
      workbuddy: 0,
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
