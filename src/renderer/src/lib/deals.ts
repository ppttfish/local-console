/**
 * 薅羊毛活动数据加载（纯渲染端，主进程零改动）
 *
 * 单一数据源是仓库里的 src/renderer/src/data/deals.json，同一份文件三处使用：
 *  1. 构建时 import 随包打入 —— 从未联网时的兜底
 *  2. 运行时从 jsDelivr / GitHub raw 拉取 —— 改 JSON 推送后所有用户打开页面即生效，无需发版
 *  3. 最近一次远程结果写 localStorage —— 断网 / 源不可达时兜底
 *
 * 展示优先级：远程 > 本地缓存 > 内置；updatedAt 只用于在缓存与内置之间取较新者。
 */
import bundledDeals from '@/data/deals.json'

export interface DealItem {
  id: string
  title: string
  description?: string
  /** 活动 / 领取页链接 */
  url?: string
  /** 链接按钮文案，默认「打开活动页」 */
  urlLabel?: string
  /** OpenAI 兼容 API 地址（可复制） */
  apiBase?: string
  /** 推荐模型名（可复制） */
  model?: string
  tags?: string[]
  startsAt?: string
  /** YYYY-MM-DD，过期后卡片沉底并置灰 */
  endsAt?: string
  pinned?: boolean
}

export interface DealsData {
  /** 数据更新日期（YYYY-MM-DD），改动条目时记得同步更新 */
  updatedAt: string
  items: DealItem[]
}

export type DealsOrigin = 'remote' | 'cache' | 'bundled'

const REMOTE_SOURCES = [
  // jsDelivr 在国内的可达性通常好于 raw.githubusercontent.com，放前面
  'https://cdn.jsdelivr.net/gh/ppttfish/local-console@main/src/renderer/src/data/deals.json',
  'https://raw.githubusercontent.com/ppttfish/local-console/main/src/renderer/src/data/deals.json'
]

const CACHE_KEY = 'deals:remote-cache:v1'
const FETCH_TIMEOUT_MS = 8000

export interface DealsLocalResult {
  data: DealsData
  origin: Exclude<DealsOrigin, 'remote'>
  fetchedAt?: number
}

export type RemoteDealsResult =
  | { ok: true; data: DealsData; fetchedAt: number }
  | { ok: false; error: string }

function isDealsData(v: unknown): v is DealsData {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<DealsData>
  return typeof d.updatedAt === 'string' && Array.isArray(d.items)
}

function readCache(): { savedAt: number; data: DealsData } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { savedAt, data } = parsed as { savedAt?: unknown; data?: unknown }
    if (typeof savedAt !== 'number' || !isDealsData(data)) return null
    return { savedAt, data }
  } catch {
    return null
  }
}

/** 同步加载本地可立即展示的数据：缓存与内置取较新者 */
export function loadLocalDeals(): DealsLocalResult {
  const bundled = bundledDeals as unknown as DealsData
  const cache = readCache()
  if (cache && cache.data.updatedAt >= bundled.updatedAt) {
    return { data: cache.data, origin: 'cache', fetchedAt: cache.savedAt }
  }
  return { data: bundled, origin: 'bundled' }
}

async function fetchOne(url: string): Promise<DealsData> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as unknown
    if (!isDealsData(json)) throw new Error('数据格式不合法')
    return json
  } finally {
    clearTimeout(timer)
  }
}

/** 依次尝试各远程源，任一成功即返回并落缓存 */
export async function fetchRemoteDeals(): Promise<RemoteDealsResult> {
  const errors: string[] = []
  for (const url of REMOTE_SOURCES) {
    try {
      const data = await fetchOne(url)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }))
      } catch {
        // 存储写失败不影响本次展示
      }
      return { ok: true, data, fetchedAt: Date.now() }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: false, error: errors.join(' / ') }
}
