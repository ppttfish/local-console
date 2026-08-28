/**
 * 订阅监控 —— 数据层
 *  - provider_subscription 表：每个 Provider 一行；存凭证、最新快照、最近错误
 *  - 凭证 v1 暂未加密（仅本机 SQLite；后续可接 electron.safeStorage）
 */
import { getDb, prepare } from '../../../services/db.js'
import { readOpencodeCredential } from './opencode-auth.js'
import type { QuotaSnapshot } from './providers/types.js'

export interface Subscription {
  id: number
  provider: string
  displayName: string
  credential: string
  config: Record<string, unknown>
  enabled: boolean
  lastRefreshAt: number | null
  lastError: string | null
  lastSnapshot: QuotaSnapshot | null
  createdAt: number
  updatedAt: number
}

export interface CreateSubscriptionInput {
  provider: string
  displayName: string
  /** 手动粘贴的凭证；与 opencodeKey 二选一 */
  credential: string
  /**
   * OpenCode auth.json 里的 key 名（如 zai-coding-plan）。
   * 提供时主进程自行读取完整凭证 —— 明文 key 不经过 IPC/HTTP 往返。
   */
  opencodeKey?: string
  config?: Record<string, unknown>
  enabled?: boolean
}

export interface UpdateSubscriptionInput {
  id: number
  displayName?: string
  credential?: string
  config?: Record<string, unknown>
  enabled?: boolean
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credential TEXT NOT NULL,
  config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_refresh_at INTEGER,
  last_error TEXT,
  last_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_sub ON provider_subscription(provider, credential);
`

export function ensureSubscriptionSchema(): void {
  getDb().exec(SCHEMA)
}

// ===== Row 映射 =====

interface Row {
  id: number
  provider: string
  display_name: string
  credential: string
  config: string | null
  enabled: number
  last_refresh_at: number | null
  last_error: string | null
  last_snapshot: string | null
  created_at: number
  updated_at: number
}

function mapRow(r: Row): Subscription {
  let cfg: Record<string, unknown> = {}
  if (r.config) {
    try {
      cfg = JSON.parse(r.config) as Record<string, unknown>
    } catch {
      cfg = {}
    }
  }
  let snap: QuotaSnapshot | null = null
  if (r.last_snapshot) {
    try {
      snap = JSON.parse(r.last_snapshot) as QuotaSnapshot
    } catch {
      snap = null
    }
  }
  return {
    id: r.id,
    provider: r.provider,
    displayName: r.display_name,
    credential: r.credential,
    config: cfg,
    enabled: r.enabled === 1,
    lastRefreshAt: r.last_refresh_at,
    lastError: r.last_error,
    lastSnapshot: snap,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

// ===== CRUD =====

export function listSubscriptions(): Subscription[] {
  const rows = prepare('SELECT * FROM provider_subscription ORDER BY id ASC')
    .all() as Row[]
  return rows.map(mapRow)
}

export function getSubscription(id: number): Subscription | null {
  const r = prepare('SELECT * FROM provider_subscription WHERE id = ?')
    .get(id) as Row | undefined
  return r ? mapRow(r) : null
}

export function createSubscription(input: CreateSubscriptionInput): Subscription {
  const now = Date.now()
  const cfg = JSON.stringify(input.config ?? {})
  const credential =
    input.opencodeKey && input.opencodeKey !== ''
      ? (readOpencodeCredential(input.opencodeKey) ?? '-')
      : input.credential
  const info = prepare(
      `INSERT INTO provider_subscription (provider, display_name, credential, config, enabled, last_refresh_at, last_error, last_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(
      input.provider,
      input.displayName,
      credential,
      cfg,
      input.enabled === false ? 0 : 1,
      now,
      now
    )
  return getSubscription(Number(info.lastInsertRowid))!
}

export function updateSubscription(
  id: number,
  patch: Partial<Omit<UpdateSubscriptionInput, 'id'>>
): Subscription {
  const cur = getSubscription(id)
  if (!cur) throw new Error(`subscription ${id} not found`)
  const next = {
    displayName: patch.displayName ?? cur.displayName,
    credential: patch.credential ?? cur.credential,
    config: patch.config ?? cur.config,
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled
  }
  const now = Date.now()
  prepare(
      `UPDATE provider_subscription
       SET display_name = ?, credential = ?, config = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.displayName,
      next.credential,
      JSON.stringify(next.config),
      next.enabled ? 1 : 0,
      now,
      id
    )
  return getSubscription(id)!
}

export function deleteSubscription(id: number): void {
  prepare('DELETE FROM provider_subscription WHERE id = ?').run(id)
}

export function setSubscriptionSnapshot(
  id: number,
  snapshot: QuotaSnapshot | null,
  error: string | null = null
): void {
  const now = Date.now()
  prepare(
      `UPDATE provider_subscription
       SET last_refresh_at = ?, last_snapshot = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(now, snapshot ? JSON.stringify(snapshot) : null, error, now, id)
}
