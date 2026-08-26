/**
 * OpenCode auth.json 凭证发现 —— 对齐 OpenChamber 的做法
 *  - 路径: %USERPROFILE%/.local/share/opencode/auth.json
 *  - 结构: { [providerId]: { type: 'api'|'oauth', key/token/access... } }
 *  - 只映射本应用有适配器的 provider；key 掩码后返回，不落日志
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** opencode auth key → 本应用 provider id */
const ALIAS_MAP: Record<string, string> = {
  'zai-coding-plan': 'zai',
  zai: 'zai',
  'z.ai': 'zai',
  'zhipuai-coding-plan': 'zhipu',
  'minimax-coding-plan': 'minimax-io',
  'minimax-cn-coding-plan': 'minimax-cn',
  'kimi-for-coding': 'kimi',
  kimi: 'kimi',
  openrouter: 'openrouter'
}

export interface DiscoveredCredential {
  /** 本应用 provider id */
  providerId: string
  /** opencode auth.json 里的原始 key 名 */
  authKey: string
  /** 掩码后的凭证（前 6 位 + …） */
  masked: string
}

function maskKey(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 8) return null
  return `${v.slice(0, 6)}…${v.slice(-4)}`
}

export function discoverOpencodeCredentials(): DiscoveredCredential[] {
  const file = join(
    homedir(),
    '.local',
    'share',
    'opencode',
    'auth.json'
  )
  if (!existsSync(file)) return []
  let auth: Record<string, unknown>
  try {
    auth = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const out: DiscoveredCredential[] = []
  for (const [authKey, entry] of Object.entries(auth)) {
    const providerId = ALIAS_MAP[authKey]
    if (!providerId) continue
    const rec =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : {}
    const raw =
      typeof rec.key === 'string'
        ? rec.key
        : typeof rec.token === 'string'
          ? rec.token
          : typeof rec.access === 'string'
            ? rec.access
            : null
    const masked = maskKey(raw)
    if (!masked) continue
    out.push({ providerId, authKey, masked })
  }
  return out
}

/** 按 opencode authKey 读出完整凭证（仅主进程内部使用，不进 IPC 返回值） */
export function readOpencodeCredential(authKey: string): string | null {
  const file = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  if (!existsSync(file)) return null
  try {
    const auth = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >
    const rec = auth[authKey]
    if (!rec || typeof rec !== 'object') return null
    const r = rec as Record<string, unknown>
    if (typeof r.key === 'string') return r.key
    if (typeof r.token === 'string') return r.token
    if (typeof r.access === 'string') return r.access
    return null
  } catch {
    return null
  }
}
