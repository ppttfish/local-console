/**
 * HTTP server —— 9600 端口，serve renderer 静态资源 + /api/* JSON 桥接
 * 可以在 Electron 内部启动，也可以 standalone 启动（无 GUI 模式）
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { URL } from 'node:url'
import { initDatabase, closeDatabase } from './services/db.js'
import { ServiceManager } from './services/service-manager.js'
import { PortScanner } from './services/port-scanner.js'
import { LogStreamer } from './services/log-streamer.js'
import { EventBus } from './services/event-bus.js'
import {
  ensureUsageSchema,
  querySummary,
  querySummaryAsync,
  queryRecap,
  queryRecapAsync,
  queryTimeline,
  queryTimelineAsync,
  listDistinctModels,
  listDistinctAgents,
  listSessions,
  listSessionsAsync
} from './plugins/builtin/token-usage/storage.js'
import { usageScanner } from './plugins/builtin/token-usage/scanner.js'
import { subscriptionRefresher } from './plugins/builtin/token-usage/refresh.js'
import { loadPricing } from './plugins/builtin/token-usage/pricing.js'
import {
  ensureSubscriptionSchema,
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  type CreateSubscriptionInput,
  type UpdateSubscriptionInput
} from './plugins/builtin/token-usage/subscriptions.js'
import { listProviderMetas } from './plugins/builtin/token-usage/providers/index.js'
import { discoverOpencodeCredentials } from './plugins/builtin/token-usage/opencode-auth.js'
import { getDataDir, getLogDir } from './utils/paths.js'
import { openLocalUrl, openLocalPath } from './utils/open-external.js'
import { app } from 'electron'
import { homedir } from 'node:os'

interface Runtime {
  svc: ServiceManager
  port: PortScanner
  log: LogStreamer
  /** 这些实例是否由本函数创建（决定 shutdown 时该不该停它们） */
  ownsRuntime: boolean
}

let runtime: Runtime | null = null
let port = 9600
let rendererDir: string | null = null
/** standalone 模式下没有 Electron app，用启动时传入的 userData 兜底 app/info */
let dataDir: string | null = null
// 极致：静态资源 stat 缓存，renderer 首次加载 20+ 文件不再逐个 stat
const statCache = new Map<string, { at: number; stat: import('node:fs').Stats | null }>()
const STAT_TTL = 5000

export async function startHttpServer(opts: {
  userData: string
  port: number
  rendererDir: string
  /**
   * Electron 主进程已有自己的 ServiceManager / PortScanner / LogStreamer 时注入进来。
   * 不注入而各建一套，会导致 Web 端启停的服务在桌面端状态里看不见（两个 procs Map）。
   */
  svc?: ServiceManager
  portScanner?: PortScanner
  logStreamer?: LogStreamer
}): Promise<void> {
  port = opts.port
  rendererDir = opts.rendererDir
  dataDir = opts.userData

  // 初始化 db（同路径时幂等，Electron 主进程已经初始化过就直接复用）
  initDatabase(opts.userData)
  ensureUsageSchema()
  ensureSubscriptionSchema()
  loadPricing()

  const ownsRuntime = !opts.svc || !opts.portScanner || !opts.logStreamer
  const bus = new EventBus()
  const logsDir = join(opts.userData, 'logs')
  const svc = opts.svc ?? new ServiceManager(bus, { userData: opts.userData, logsDir })
  const portScanner = opts.portScanner ?? new PortScanner(bus)
  const logStreamer = opts.logStreamer ?? new LogStreamer(bus, logsDir)

  if (ownsRuntime) {
    await svc.start()
    await portScanner.start()
  }
  // 让 ServiceState 携带真实端口占用信息（外部接管条目的状态展示依赖它）
  svc.setPortProvider(() => portScanner.snapshot())
  // 单例、幂等：Electron 模式下插件和 IPC 层已经起过了，这里再调不会重复扫描
  usageScanner.start()
  subscriptionRefresher.start()

  runtime = { svc, port: portScanner, log: logStreamer, ownsRuntime }

  const server = createServer((req, res) => handle(req, res))
  server.on('error', (err) => {
    // 端口被占用（如另一份实例已在跑）不要因此把整个主进程拖崩，仅记日志
    console.error(`[http] 监听 ${port} 失败：${err.message}`)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[http] 已启动 http://127.0.0.1:${port}`)
  })

  // graceful shutdown
  const shutdown = async () => {
    console.log('[http] 关闭...')
    if (runtime?.ownsRuntime) {
      await svc.shutdown()
      await portScanner.stop()
      usageScanner.stop()
      subscriptionRefresher.stop()
      closeDatabase()
    }
    server.close()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const pathname = url.pathname

  // API
  if (pathname.startsWith('/api/')) {
    return handleApi(pathname, url, req, res)
  }

  // 静态文件
  if (!rendererDir) {
    res.statusCode = 500
    res.end('renderer not built')
    return
  }
  const p = pathname === '/' ? '/index.html' : pathname
  // 防目录穿越
  const filePath = normalize(join(rendererDir, p))
  if (!filePath.startsWith(normalize(rendererDir))) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  // 极致：stat 缓存 + ETag/304，避免 20+ 静态资源每次刷新都 stat + 全量下发
  let st: import('node:fs').Stats | null = null
  const cached = statCache.get(filePath)
  if (cached && Date.now() - cached.at < STAT_TTL) {
    st = cached.stat
  } else {
    try { st = await statAsync(filePath) } catch { st = null }
    statCache.set(filePath, { at: Date.now(), stat: st })
    if (statCache.size > 200) {
      const first = statCache.keys().next().value
      if (first) statCache.delete(first)
    }
  }
  if (!st || !st.isFile()) {
    // SPA fallback（hash 路由下除静态资源外都回 index.html）
    const fallback = join(rendererDir, 'index.html')
    if (existsSync(fallback)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      // index.html 不能缓存，否则发新版后浏览器一直拿旧的入口
      res.setHeader('Cache-Control', 'no-cache')
      createReadStream(fallback).pipe(res)
      return
    }
    res.statusCode = 404
    res.end('not found')
    return
  }
  const ext = extname(filePath).toLowerCase()
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  }
  const etag = `"${st.size}-${st.mtimeMs.toString(36)}"`
  const ifNoneMatch = req.headers['if-none-match']
  const ifModifiedSince = req.headers['if-modified-since']
  if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(st.mtimeMs))) {
    res.statusCode = 304
    res.end()
    return
  }
  res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
  res.setHeader('Content-Length', st.size)
  res.setHeader('ETag', etag)
  res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString())
  // Vite 产物文件名带 hash，可以放心长缓存；非 hash 的 index.html 走上面的 no-cache
  res.setHeader(
    'Cache-Control',
    /-[A-Za-z0-9_]{8}\./.test(basenameOf(filePath))
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  )
  // 用流而不是 readFileSync：JS/CSS 动辄上 MB，同步读会阻塞整个 HTTP server
  createReadStream(filePath).pipe(res)
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

async function handleApi(
  pathname: string,
  _url: URL,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!runtime) {
    json(res, 500, { ok: false, error: 'runtime not ready' })
    return
  }
  // CORS（允许本机任意源）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    const body = await readJsonBody(req)
    const r = runtime

    if (pathname === '/api/app/open-url' && req.method === 'POST') {
      const { url } = body as { url: string }
      return json(res, 200, await openLocalUrl(url))
    }
    if (pathname === '/api/app/info' && req.method === 'GET') {
      // standalone（ELECTRON_RUN_AS_NODE）下 import 到的 electron 只是路径字符串，
      // app 为 undefined，getName/getVersion/getPath 都会抛错，这里全部兜底
      const appName = typeof app?.getName === 'function' ? app.getName() : '小福鱼'
      const appVersion =
        typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0'
      return json(res, 200, {
        name: appName,
        version: appVersion,
        dataDir: dataDir ?? getDataDir(),
        logDir: dataDir ? join(dataDir, 'logs') : getLogDir(),
        homeDir: homedir()
      })
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      // 复用 ServiceManager 的快照，跟 IPC 链路保持同一套指标口径
      return json(res, 200, r.svc.snapshotState())
    }
    if (pathname === '/api/port/scan' && req.method === 'GET') {
      return json(res, 200, r.port.snapshot())
    }
    if (pathname === '/api/service/list' && req.method === 'GET') {
      return json(res, 200, r.svc.list())
    }
    if (pathname === '/api/service/get') {
      const id = _url.searchParams.get('id') ?? ''
      return json(res, 200, r.svc.get(id))
    }
    if (pathname === '/api/service/clear-logs' && req.method === 'POST') {
      const { id } = body as { id: string }
      r.log.clear(id)
      return json(res, 200, { ok: true })
    }
    // 注意顺序：/api/service/reorder 必须排在 /api/service/:id/:action 之前
    if (pathname === '/api/service/reorder' && req.method === 'POST') {
      const { ids } = body as { ids?: string[] }
      if (!Array.isArray(ids)) {
        return json(res, 400, { ok: false, error: 'ids 必须是数组' })
      }
      r.svc.reorder(ids)
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/service/reset-log-size' && req.method === 'POST') {
      // 日志被清空后要把内存里的字节计数一起归零，否则会提前触发轮转
      const { id } = body as { id: string }
      r.svc.resetLogCounter(id)
      return json(res, 200, { ok: true })
    }
    if (pathname.startsWith('/api/service/') && req.method === 'POST') {
      const parts = pathname.split('/')
      const id = parts[3]!
      const action = parts[4]
      if (action === 'start') return json(res, 200, await r.svc.startService(id, 'ui'))
      if (action === 'stop') return json(res, 200, await r.svc.stop(id, 'ui'))
      if (action === 'restart') return json(res, 200, await r.svc.restart(id, 'ui'))
    }
    if (pathname === '/api/service/stop-external' && req.method === 'POST') {
      const { id } = body as { id: string }
      return json(res, 200, await r.svc.stopExternal(id, 'ui'))
    }
    if (pathname === '/api/service/create' && req.method === 'POST') {
      return json(res, 200, r.svc.create(body as Parameters<typeof r.svc.create>[0]))
    }
    if (pathname === '/api/service/update' && req.method === 'POST') {
      const { id, ...patch } = body as { id: string } & Record<string, unknown>
      return json(res, 200, r.svc.update(id, patch))
    }
    if (pathname === '/api/service/delete' && req.method === 'POST') {
      const { id } = body as { id: string }
      await r.svc.delete(id)
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/service/logs' && req.method === 'POST') {
      const { id, tail, force } = body as {
        id: string
        tail?: number
        force?: boolean
      }
      return json(res, 200, await r.log.tail(id, tail ?? 300, force))
    }

    // Project detect
    if (pathname === '/api/project/detect' && req.method === 'POST') {
      const { cwd } = body as { cwd: string }
      return json(res, 200, await r.svc.detectProject(cwd))
    }
    // Web 端没有原生目录选择框，返回"不支持"而不是 404，
    // 免得前端把它当接口缺失
    if (pathname === '/api/project/pick-folder' && req.method === 'POST') {
      return json(res, 200, { ok: false, canceled: true, unsupported: true })
    }

    // App 控制：这些原本只在 IPC 里有，web-bridge 会调，缺了就静默 404
    if (pathname === '/api/app/open-log-dir' && req.method === 'POST') {
      void openLocalPath(getLogDir())
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/app/open-data-dir' && req.method === 'POST') {
      void openLocalPath(getDataDir())
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/app/quit' && req.method === 'POST') {
      // standalone 模式下没有 Electron app，直接结束进程
      setTimeout(() => process.exit(0), 100)
      return json(res, 200, { ok: true })
    }

    // token-usage
    if (pathname === '/api/usage/summary' && req.method === 'POST') {
      return json(res, 200, querySummary(body as Parameters<typeof querySummary>[0]))
    }
    if (pathname === '/api/usage/timeline' && req.method === 'POST') {
      const { filter, granularity } = body as {
        filter: Parameters<typeof queryTimeline>[0]
        granularity: 'hour' | 'day' | 'month'
      }
      return json(res, 200, { timeline: queryTimeline(filter, granularity) })
    }
    if (pathname === '/api/usage/models' && req.method === 'GET') {
      return json(res, 200, listDistinctModels())
    }
    if (pathname === '/api/usage/agents' && req.method === 'GET') {
      return json(res, 200, listDistinctAgents())
    }
    if (pathname === '/api/usage/sessions' && req.method === 'POST') {
      const { filter, limit } = body as {
        filter: Parameters<typeof listSessions>[0]
        limit?: number
      }
      return json(res, 200, listSessions(filter, limit ?? 200))
    }
    if (pathname === '/api/usage/rescan' && req.method === 'POST') {
      try {
        // 异步触发：立即返回 { started }，全量重建在后台队列执行，
        // 前端轮询 status.scanning / last_scan_at 判断完成，请求不再卡 20-25s
        return json(res, 200, usageScanner.startRescan())
      } catch (e) {
        console.error('[token-usage] rescan 触发失败:', e)
        return json(res, 500, { error: (e as Error)?.message ?? String(e) })
      }
    }
    if (pathname === '/api/usage/status' && req.method === 'GET') {
      return json(res, 200, usageScanner.getStats())
    }
    if (pathname === '/api/usage/recap' && req.method === 'GET') {
      try { return json(res, 200, await queryRecapAsync()) } catch { return json(res, 200, queryRecap()) }
    }
    if (pathname === '/api/usage/batch' && req.method === 'POST') {
      const { filter, granularity, limit } = body as {
        filter: Parameters<typeof querySummary>[0]
        granularity: 'hour' | 'day' | 'month'
        limit?: number
      }
      const summary = await querySummaryAsync(filter)
      await new Promise<void>((r) => setImmediate(r))
      const tl = await queryTimelineAsync(filter, granularity)
      await new Promise<void>((r) => setImmediate(r))
      const sessions = await listSessionsAsync(filter, limit ?? 50)
      return json(res, 200, {
        summary,
        timeline: { timeline: tl },
        sessions,
        models: listDistinctModels(),
        status: usageScanner.getStats()
      })
    }

    // ===== 订阅监控 =====
    if (pathname === '/api/subscription/list' && req.method === 'GET') {
      return json(res, 200, listSubscriptions())
    }
    if (pathname === '/api/subscription/providers' && req.method === 'GET') {
      return json(res, 200, listProviderMetas())
    }
    if (pathname === '/api/subscription/discover' && req.method === 'GET') {
      return json(res, 200, discoverOpencodeCredentials())
    }
    if (pathname === '/api/subscription/get' && req.method === 'GET') {
      const id = Number(_url.searchParams.get('id'))
      return json(res, 200, getSubscription(id))
    }
    if (pathname === '/api/subscription/create' && req.method === 'POST') {
      return json(res, 200, createSubscription(body as CreateSubscriptionInput))
    }
    if (pathname === '/api/subscription/update' && req.method === 'POST') {
      const { id, ...patch } = body as UpdateSubscriptionInput
      return json(res, 200, updateSubscription(id, patch))
    }
    if (pathname === '/api/subscription/delete' && req.method === 'POST') {
      const { id } = body as { id: number }
      deleteSubscription(id)
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/subscription/refresh' && req.method === 'POST') {
      const { id } = body as { id: number }
      await subscriptionRefresher.refreshOne(id)
      return json(res, 200, getSubscription(id))
    }

    return json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e) })
  }
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.statusCode = code
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('invalid json: ' + (e as Error).message))
      }
    })
    req.on('error', reject)
  })
}
