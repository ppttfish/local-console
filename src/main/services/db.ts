/**
 * SQLite 封装 —— better-sqlite3 同步 API。
 * 数据库位置：可由调用方注入（Electron 传 app.getPath('userData')，standalone 传本地解析路径）。
 */
import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let db: Database.Database | null = null
let dbPath: string | null = null

/**
 * 语句缓存。
 * better-sqlite3 没有内置缓存，每次 `prepare()` 都要重新编译一遍 SQL。
 * 状态轮询（2s）和用量查询（30s，一次 5 条）走的全是固定语句，缓存收益明显。
 * initDatabase 重建连接时会清空。
 */
const stmtCache = new Map<string, Database.Statement>()

export function prepare(sql: string): Database.Statement {
  const conn = getDb()
  const hit = stmtCache.get(sql)
  if (hit) return hit
  const stmt = conn.prepare(sql)
  stmtCache.set(sql, stmt)
  return stmt
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('service','task')),
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  port INTEGER,
  color TEXT,
  group_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  pid INTEGER,
  pgid INTEGER,
  trigger TEXT NOT NULL CHECK(trigger IN ('ui','cli','mcp','system')),
  trigger_detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_service ON run_history(service_id);
CREATE INDEX IF NOT EXISTS idx_run_started ON run_history(started_at);

CREATE TABLE IF NOT EXISTS log_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_service ON log_files(service_id);

CREATE TABLE IF NOT EXISTS port_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,
  port INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  process_name TEXT,
  cwd TEXT,
  cmd TEXT
);
CREATE INDEX IF NOT EXISTS idx_port_at ON port_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT
);
`

export function initDatabase(userDataDir?: string): void {
  const dir = userDataDir ?? process.env['LOCAL_CONSOLE_DATA_DIR'] ?? process.cwd()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const nextPath = join(dir, 'state.db')
  // 幂等：Electron 主进程和同进程内的 HTTP server 都会调一次。
  // 旧实现直接覆盖模块级 db，前一个连接既没 close 也再没人引用，等于泄漏。
  if (db && dbPath === nextPath) return
  if (db) {
    try {
      db.close()
    } catch {
      // 关不掉也继续，不能因为清理失败就卡住启动
    }
  }
  dbPath = nextPath
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  stmtCache.clear()
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function getDbPath(): string | null {
  return dbPath
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ========== Service CRUD ==========

export interface ServiceRow {
  id: string
  name: string
  kind: 'service' | 'task'
  cwd: string
  command: string
  port: number | null
  color: string | null
  group_name: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export function listServices(): ServiceRow[] {
  return prepare('SELECT * FROM services ORDER BY sort_order ASC, created_at ASC')
    .all() as ServiceRow[]
}

export function getService(id: string): ServiceRow | undefined {
  return prepare('SELECT * FROM services WHERE id = ?')
    .get(id) as ServiceRow | undefined
}

export function createServiceRow(row: ServiceRow): void {
  prepare(
      `INSERT INTO services (id, name, kind, cwd, command, port, color, group_name, sort_order, created_at, updated_at)
       VALUES (@id, @name, @kind, @cwd, @command, @port, @color, @group_name, @sort_order, @created_at, @updated_at)`
    )
    .run(row)
}

export function updateServiceRow(id: string, patch: Partial<ServiceRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== 'id')
  if (fields.length === 0) return
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  prepare(
      `UPDATE services SET ${setClause}, updated_at = @updated_at WHERE id = @id`
    )
    .run({ ...patch, id, updated_at: Date.now() })
}

export function deleteServiceRow(id: string): void {
  prepare('DELETE FROM services WHERE id = ?').run(id)
}

export function reorderServices(ids: string[]): void {
  const stmt = prepare(
    'UPDATE services SET sort_order = ? WHERE id = ?'
  )
  const tx = getDb().transaction((rows: string[]) => {
    rows.forEach((id, idx) => stmt.run(idx, id))
  })
  tx(ids)
}

// ========== Run history ==========

export function insertRunStart(input: {
  service_id: string
  pid: number | null
  pgid: number | null
  trigger: string
  trigger_detail: string | null
}): number {
  const r = prepare(
      `INSERT INTO run_history (service_id, started_at, pid, pgid, trigger, trigger_detail)
       VALUES (@service_id, @started_at, @pid, @pgid, @trigger, @trigger_detail)`
    )
    .run({ ...input, started_at: Date.now() })
  return r.lastInsertRowid as number
}

/** 进程 pid 要等 spawn 之后才有，回填到刚插入的那条 run_history */
export function updateRunPid(runId: number, pid: number | null): void {
  prepare('UPDATE run_history SET pid = ? WHERE id = ?').run(pid, runId)
}

export function updateRunEnd(runId: number, exitCode: number | null): void {
  prepare('UPDATE run_history SET ended_at = ?, exit_code = ? WHERE id = ?')
    .run(Date.now(), exitCode, runId)
}
