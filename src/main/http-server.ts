/**
 * HTTP server —— 9600 端口，serve renderer 静态资源 + /api/* JSON 桥接
 * 可以在 Electron 内部启动，也可以 standalone 启动（无 GUI 模式）
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
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
  queryTimeline,
  listDistinctModels,
  listDistinctAgents,
  listSessions
} from './plugins/builtin/token-usage/storage.js'
import { UsageScanner } from './plugins/builtin/token-usage/scanner.js'
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
import { SubscriptionRefresher } from './plugins/builtin/token-usage/refresh.js'
import { listProviderMetas } from './plugins/builtin/token-usage/providers/index.js'
import { discoverOpencodeCredentials } from './plugins/builtin/token-usage/opencode-auth.js'
import { getDataDir, getLogDir } from './utils/paths.js'
import { openLocalUrl } from './utils/open-external.js'
import { app } from 'electron'
import { homedir } from 'node:os'

interface Runtime {
  svc: ServiceManager
  port: PortScanner
  log: LogStreamer
  usageScanner: UsageScanner
  subRefresher: SubscriptionRefresher
}

let runtime: Runtime | null = null
let port = 9600
let rendererDir: string | null = null

export async function startHttpServer(opts: {
  userData: string
  port: number
  rendererDir: string
}): Promise<void> {
  port = opts.port
  rendererDir = opts.rendererDir

  // 初始化 db

  initDatabase(opts.userData)
  ensureUsageSchema()
  ensureSubscriptionSchema()
  loadPricing()

  // 业务
  const bus = new EventBus()
  const logsDir = join(opts.userData, 'logs')
  const svc = new ServiceManager(bus, { userData: opts.userData, logsDir })
  const portScanner = new PortScanner(bus)
  const logStreamer = new LogStreamer(bus, logsDir)
  const usageScanner = new UsageScanner()
  const subRefresher = new SubscriptionRefresher()

  await svc.start()
  await portScanner.start()
  // 让 ServiceState 携带真实端口占用信息（外部接管条目的状态展示依赖它）
  svc.setPortProvider(() => portScanner.snapshot())
  await usageScanner.start()
  subRefresher.start()

  runtime = { svc, port: portScanner, log: logStreamer, usageScanner, subRefresher }

  const server = createServer((req, res) => handle(req, res))
  server.listen(port, '127.0.0.1', () => {
    console.log(`[http] 已启动 http://127.0.0.1:${port}`)
  })

  // graceful shutdown
  const shutdown = async () => {
    console.log('[http] 关闭...')
    await svc.shutdown()
    await portScanner.stop()
    usageScanner.stop()
    subRefresher.stop()
    server.close()
    closeDatabase()
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
  let p = pathname === '/' ? '/index.html' : pathname
  // 防目录穿越
  const filePath = normalize(join(rendererDir, p))
  if (!filePath.startsWith(normalize(rendererDir))) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback
    const fallback = join(rendererDir, 'index.html')
    if (existsSync(fallback)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(readFileSync(fallback, 'utf8'))
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
  res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
  res.end(readFileSync(filePath))
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
      return json(res, 200, {
        name: app.getName(),
        version: app.getVersion(),
        dataDir: getDataDir(),
        logDir: getLogDir(),
        homeDir: homedir()
      })
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      const services = r.svc.list()
      const ports = r.port.snapshot()
      return json(res, 200, {
        services,
        ports,
        total_cpu: 0,
        total_mem: 0,
        alerts: [],
        captured_at: Date.now()
      })
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
      r.svc.delete(id)
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/service/logs' && req.method === 'POST') {
      const { id, tail } = body as { id: string; tail?: number }
      return json(res, 200, r.log.tail(id, tail ?? 300))
    }

    // Project detect
    if (pathname === '/api/project/detect' && req.method === 'POST') {
      const { cwd } = body as { cwd: string }
      return json(res, 200, r.svc.detectProject(cwd))
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
      return json(res, 200, await r.usageScanner.rescan())
    }
    if (pathname === '/api/usage/status' && req.method === 'GET') {
      return json(res, 200, r.usageScanner.getStats())
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
      await r.subRefresher.refreshOne(id)
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
