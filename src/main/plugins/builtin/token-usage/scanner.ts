/**
 * 文件发现 + 增量扫描 v2
 *  - omp / zcode / codex / claude 走 jsonl 增量
 *  - opencode 走 SQLite 直查（db 文件 mtime 做 cursor key）
 *  - dsh 走 zstd 压缩 jsonl（无法按行增量，文件指纹变了全删全写）
 */
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { parserForFile, sessionIdFromFile, readOpenCodeDb, parseDshSession, readZcodeDb, parseCodexSession } from './parsers.js'
import {
  ensureUsageSchema,
  insertUsageBatch,
  getCursor,
  upsertCursor,
  resetAllCursors,
  deleteUsageBySourceFile,
  countLegacyRows,
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
  /**
   * opencode.db 的实际写入者：OpenChamber 与原生 OpenCode 共用
   * ~/.local/share/opencode，按本机特征判断该口径该显示哪个名字
   */
  opencode_flavor: 'openchamber' | 'opencode'
  /** 检测到「已入库前缀被改写」而触发整文件重建的次数（本次进程累计） */
  rewrites: number
  /** 最近一次重建的文件与耗时，便于定位丢数据的元凶 */
  last_rewrite: { file: string; rows: number; at: number } | null
  /** source_file 为空的历史行数；> 0 时建议手动重扫一次以打上来源标记 */
  legacy_rows: number
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
  /** dsh 所有会话文件的 (path|size|mtime) 指纹；变化才全量重建 */
  private dshFingerprint: string | null = null
  /** zcode db.sqlite 的 mtime；变了才全删全写 model_usage */
  private zcodeDbLastMtime: { path: string; mtime: number } | null = null
  /**
   * 扫描串行队列。
   * 定时器 tick 与 rescan 都往队列里排，保证同一时刻只有一个扫描在跑。
   * 用队列而不是「scanning 标志 + 直接跳过」：跳过会让 rescan 在定时器扫描
   * 未结束时静默失效 —— 而 rescan 已经先清了 agent_usage，结果就是
   * 「数据被清空但没重建」，用户点重新扫描看着像没反应、数据反而更少。
   */
  private scanQueue: Promise<void> = Promise.resolve()

  start(): void {
    // 幂等：插件、IPC、HTTP 三个入口都会调 start，只允许第一个真正起定时器
    if (this.timer) return
    ensureUsageSchema()
    void this.enqueueScan()
    this.timer = setInterval(() => void this.enqueueScan(), 30_000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  getStats(): ScannerStats {
    return this.stats
  }

  private enqueueScan(): Promise<void> {
    const next = this.scanQueue.then(() => this.runScanAll())
    // 队列吞掉错误，避免一个失败的扫描把后面的所有扫描都挡死
    this.scanQueue = next.catch(() => undefined)
    return next
  }

  async rescan(): Promise<ScannerStats> {
    resetAllCursors()
    // jsonl 类 agent 靠 cursor 增量去重，cursor 重置后若不先清旧行，
    // 全文件重扫会与旧数据叠加导致用量翻倍；全删重建最简单可靠
    getDb().prepare('DELETE FROM agent_usage').run()
    this.stats = freshStats()
    this.opencodeLastMtime = null
    this.dshFingerprint = null
    this.zcodeDbLastMtime = null
    // 排队等前面的扫描跑完，确保这次重建一定会执行
    await this.enqueueScan()
    return this.stats
  }

  private async runScanAll(): Promise<void> {
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
      // zcode 权威用量源：db.sqlite 的 model_usage 保留全部会话完整用量，
      // rollout model-io 文件被 ZCode 压缩/清理后这里是唯一留存
      try {
        totalNew += this.scanZcodeDb()
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 zcode db 失败:', e)
      }
      try {
        totalNew += await this.scanOpenCode()
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 opencode.db 失败:', e)
      }
      try {
        totalNew += this.scanDsh()
      } catch (e) {
        this.stats.errors++
        console.warn('[token-usage] 扫 dsh sessions 失败:', e)
      }
    } catch (e) {
      this.stats.errors++
      console.error('[token-usage] scanAll 异常:', e)
    }
    this.stats.rows_inserted += totalNew
    this.stats.last_scan_at = Date.now()
    this.stats.legacy_rows = countLegacyRows()
    this.emit('scanned', { files: this.stats.files_scanned, rows: totalNew })
  }

  /**
   * 单个 jsonl 的增量扫描。
   *
   * 行号游标只在「文件纯追加」的前提下成立。ZCode 的 model-io-*.jsonl 会被
   * 压缩重写：行数变少、内容重排。此时按行号续读会直接跳过重写窗口里的全部
   * 用量，且再也补不回来（游标已经越过那些行）。所以每次扫描都要先校验
   * 「已经入库的那段前缀」是否还是原来的内容，变了就整文件重建。
   */
  private async scanJsonlFile(file: DiscoveredFile): Promise<number> {
    const st = statSync(file.path)
    const cursor = getCursor(file.path)
    // size/mtime 捷径只在「有指纹基线」时才可信。
    //
    // 老游标（head_hash 为 NULL）不能信：线上出现过游标的 size/mtime 与文件一致、
    // 但 lines_seen 已经越过文件末尾的脏状态（旧版按行号增量在文件被压缩重写后
    // 留下的），走捷径会跳过重建，重写窗口里的数据继续永久丢失。
    // 没有基线时强制读一次文件：正常续读并建立 head_hash，之后恢复捷径。
    if (
      cursor &&
      cursor.head_hash !== null &&
      cursor.file_size === st.size &&
      cursor.file_mtime === Math.floor(st.mtimeMs)
    ) {
      return 0
    }

    const content = readFileSync(file.path, 'utf8')
    const lines = content.split('\n')
    // 关键口径：文件以 \n 结尾时 split 会多出一个空元素。
    // 例如 7 行文件 -> ['行1'..'行7',''] 长度 8。若不 pop，行数口径比真实行数
    // 大 1，游标 lines_seen=8 与"7 行文件"会被判定为相等（shrunk=false），
    // 文件被压缩重写后检测不到，重写窗口的数据继续丢。
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    // codex 走整文件有状态解析（turn_context 模型 + total 增量），不能按行增量 slice
    // 否则会丢模型上下文且 total 差值错乱。此处若文件有任何变动则全量重建
    if (file.agent === 'codex') {
      const alreadyDone = cursor &&
        cursor.head_hash !== null &&
        cursor.file_size === st.size &&
        cursor.file_mtime === Math.floor(st.mtimeMs)
      if (alreadyDone) return 0
      const codexRows = parseCodexSession(file.path, file.sessionId)
      // 全删全写避免残留（file 追加后旧行仍在库里，重复会翻倍）
      deleteUsageBySourceFile(file.path, file.agent, file.sessionId)
      const toInsert: UsageRow[] = codexRows.map(r => ({ ...r, source_file: file.path }))
      if (toInsert.length > 0) {
        insertUsageBatch(toInsert)
        this.stats.by_agent[file.agent] =
          (this.stats.by_agent[file.agent] ?? 0) + toInsert.length
      }
      const rebuilt = !!cursor && (lines.length < (cursor.lines_seen ?? 0) || (cursor.head_hash !== null && cursor.head_hash !== headFingerprint(lines, cursor.lines_seen ?? 0)))
      if (rebuilt) {
        this.stats.rewrites++
        this.stats.last_rewrite = { file: file.path, rows: toInsert.length, at: Date.now() }
        console.warn(
          `[token-usage] 检测到文件被重写，已整文件重建：${file.path}` +
            `（游标 ${cursor?.lines_seen ?? 0} 行 → 现有 ${lines.length} 行，重建出 ${toInsert.length} 行）`
        )
      }
      upsertCursor(file.path, st.size, Math.floor(st.mtimeMs), lines.length, headFingerprint(lines, lines.length))
      return 0 // 全量重建不计为增量，避免 rows_inserted 翻倍
    }

    const parser = parserForFile(file.agent, file.path)
    if (!parser) return 0

    // 已入库前缀是否被改写？head_hash 为 NULL 是升级前的老游标，
    // 没有基线可比，先按原逻辑续读，这一轮写完指纹后后续就能检测了。
    let startFrom = 0
    let rebuilt = false
    if (cursor) {
      const shrunk = lines.length < cursor.lines_seen
      const drifted =
        cursor.head_hash !== null &&
        cursor.head_hash !== headFingerprint(lines, cursor.lines_seen)
      if (!shrunk && !drifted) {
        startFrom = cursor.lines_seen
      } else {
        // 全删全写：source_file 是干净的删除边界（session_id 可能被行内字段覆盖）
        deleteUsageBySourceFile(file.path, file.agent, file.sessionId)
        rebuilt = true
      }
    }

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
      if (row) newRows.push({ ...row, source_file: file.path })
    }
    if (newRows.length > 0) {
      insertUsageBatch(newRows)
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
    return rebuilt ? 0 : newRows.length
  }

  /**
   * zcode 权威用量源：db.sqlite 的 model_usage 全删全写。
   *
   * rollout 的 model-io jsonl 会被 ZCode 压缩/清理（行数变少、内容重排），
   * 无论怎么增量都追不齐；db.sqlite 的 model_usage 表保留所有（主 + 子）会话
   * 每次模型调用的完整用量（token 四元组 + started_at），是唯一可靠来源。
   * 与 dsh / opencode 同策略：db 文件 mtime 变了就全删全写。
   */
  private scanZcodeDb(): number {
    const dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
    if (!existsSync(dbPath)) return 0
    const st = statSync(dbPath)
    const mtime = Math.floor(st.mtimeMs)
    if (
      this.zcodeDbLastMtime &&
      this.zcodeDbLastMtime.path === dbPath &&
      this.zcodeDbLastMtime.mtime === mtime
    ) {
      return 0
    }
    const rows = readZcodeDb(dbPath)
    if (rows.length === 0) {
      this.zcodeDbLastMtime = { path: dbPath, mtime }
      return 0
    }
    // 全删全写：zcode 唯一权威来源，顺带清掉 rollout / 旧 transcript 的历史残留
    getDb().prepare("DELETE FROM agent_usage WHERE agent = 'zcode'").run()
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
    if (usageRows.length > 0) {
      insertUsageBatch(usageRows)
      this.stats.by_agent['zcode'] =
        (this.stats.by_agent['zcode'] ?? 0) + usageRows.length
    }
    this.zcodeDbLastMtime = { path: dbPath, mtime }
    return usageRows.length
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
    const rows = readOpenCodeDb(dbPath, minAtForAgent('opencode'))
    if (rows.length === 0) {
      this.opencodeLastMtime = { path: dbPath, mtime, count: 0 }
      return 0
    }
    // opencode 没有稳定 request_id；用全删全写简化去重
    getDb().prepare('DELETE FROM agent_usage WHERE agent = ?').run('opencode')
    const usageRows: UsageRow[] = rows.map((r) => ({
      agent: 'opencode',
      model: r.model,
      // opencode 存储 fresh：input 为非缓存 fresh，cache 单独分桶
      // 统一所有源为 fresh 存储，总消耗 = fresh + cached + output
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
    if (usageRows.length > 0) {
      insertUsageBatch(usageRows)
      this.stats.by_agent['opencode'] =
        (this.stats.by_agent['opencode'] ?? 0) + usageRows.length
    }
    this.opencodeLastMtime = { path: dbPath, mtime, count: rows.length }
    this.stats.opencode_messages = rows.length
    return usageRows.length
  }

  /** dsh：~/.dsh/sessions 下的 session.jsonl.zstd，指纹变化才全删全写 */
  private scanDsh(): number {
    const root = join(homedir(), '.dsh', 'sessions')
    if (!existsSync(root)) return 0
    const files: Array<{ path: string; sessionId: string }> = []
    walkJsonl(
      root,
      (p) => {
        files.push({ path: p, sessionId: sessionIdFromFile('dsh', p) })
      },
      0,
      /\.jsonl\.zstd$/
    )
    if (files.length === 0) return 0
    // 指纹 = 每个文件的 size+mtime；zstd 流无法按行增量，只能整体重建
    const parts: string[] = []
    for (const f of files) {
      const st = statSync(f.path)
      parts.push(`${f.path}:${st.size}:${Math.floor(st.mtimeMs)}`)
    }
    const fingerprint = parts.sort().join('|')
    if (this.dshFingerprint === fingerprint) return 0

    getDb().prepare('DELETE FROM agent_usage WHERE agent = ?').run('dsh')
    const all: UsageRow[] = []
    for (const f of files) {
      try {
        const rows = parseDshSession(f.path, f.sessionId)
        for (const r of rows) all.push({ ...r, source_file: f.path })
      } catch (e) {
        this.stats.errors++
        console.warn(`[token-usage] 解析 dsh 会话 ${f.path} 失败:`, e)
      }
    }
    if (all.length > 0) insertUsageBatch(all)
    this.dshFingerprint = fingerprint
    this.stats.by_agent['dsh'] = (this.stats.by_agent['dsh'] ?? 0) + all.length
    this.stats.dsh_sessions = files.length
    return all.length
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

/**
 * 进程级单例。
 * 插件 onLoad、IPC 注册、HTTP server 三个入口都要用扫描器；
 * 各 new 一个的话同一批 jsonl 每 30 秒会被全量解析三次。
 */
export const usageScanner = new UsageScanner()

function walkJsonl(
  dir: string,
  onFile: (path: string) => void,
  depth = 0,
  match: RegExp = /\.jsonl$/
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
      walkJsonl(full, onFile, depth + 1, match)
    } else if (st.isFile() && match.test(name) && !name.endsWith('.bak')) {
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
      dsh: 0,
      unknown: 0
    },
    errors: 0,
    opencode_messages: 0,
    dsh_sessions: 0,
    opencode_flavor: detectOpenCodeFlavor(),
    rewrites: 0,
    last_rewrite: null,
    legacy_rows: 0
  }
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

/**
 * 已入库前缀（前 upto 行）的指纹。
 *
 * 设计约束：zcode 的 model-io jsonl 单行可达 300KB、整文件几十 MB，而每 30 秒
 * 就要扫一次，所以不能对整段前缀做哈希。这里只取三个廉价但有区分度的量：
 *   1. 前缀行数 —— 捕获压缩导致的行数变少；
 *   2. 前缀字符总数 —— 捕获任意行的增删与重排；
 *   3. 首行头 128 字符 + 末行尾 128 字符的哈希 —— 捕获"行数与总长恰好相同"的改写。
 * 复杂度只是 O(n) 累加字符串长度，不做全量摘要。
 */
function headFingerprint(lines: string[], upto: number): string {
  const n = Math.min(upto, lines.length)
  let chars = 0
  for (let i = 0; i < n; i++) chars += lines[i]!.length
  const head = lines[0]?.slice(0, 128) ?? ''
  const tail = n > 0 ? (lines[n - 1] ?? '').slice(-128) : ''
  return `${n}:${chars}:${shortHash(head)}:${shortHash(tail)}`
}

/**
 * 判断 ~/.local/share/opencode 的写入者是 OpenChamber 还是原生 OpenCode。
 * 两者共用同一数据目录无法按数据区分，只能按本机安装特征：
 * OpenChamber 的配置目录（含 managed-opencode 等）是最强信号，
 * 备份文件名是次级信号；都没有则当作原生 OpenCode。
 */
function detectOpenCodeFlavor(): 'openchamber' | 'opencode' {
  const home = homedir()
  try {
    if (statSync(join(home, '.config', 'openchamber')).isDirectory()) {
      return 'openchamber'
    }
  } catch {
    // 不存在，继续
  }
  try {
    if (existsSync(join(home, '.local', 'share', 'opencode', 'auth.json.openchamber.backup'))) {
      return 'openchamber'
    }
  } catch {
    // ignore
  }
  return 'opencode'
}
