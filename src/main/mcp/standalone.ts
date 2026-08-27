/**
 * MCP Server standalone 入口 —— 通过 stdio 暴露给 agent。
 * 注册 11 个工具：8 个服务管理 + 3 个 token-usage。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { ServiceManager } from '../services/service-manager.js'
import { PortScanner } from '../services/port-scanner.js'
import { LogStreamer } from '../services/log-streamer.js'
import { EventBus } from '../services/event-bus.js'
import {
  initDatabase,
  closeDatabase,
  getService as dbGetService
} from '../services/db.js'
import { ensureUsageSchema, querySummary, queryTimeline, listDistinctAgents, listDistinctModels, type UsageFilter } from '../plugins/builtin/token-usage/storage.js'
import { UsageScanner } from '../plugins/builtin/token-usage/scanner.js'

const userData = resolveUserData()
if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
const logsDir = join(userData, 'logs')
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

function resolveUserData(): string {
  const base =
    process.env['LOCAL_CONSOLE_DATA_DIR'] ||
    process.env['LOCALAPPDATA'] ||
    process.env['APPDATA'] ||
    process.cwd()
  return join(base, 'local-console')
}

const bus = new EventBus()
initDatabase(userData)
const svc = new ServiceManager(bus, { userData, logsDir })
const port = new PortScanner(bus)
svc.setPortProvider(() => port.snapshot())
const log = new LogStreamer(bus, logsDir)
ensureUsageSchema()
const usageScanner = new UsageScanner()
void usageScanner.start()
await svc.start()
await port.start()

const server = new McpServer({
  name: 'local-console',
  version: '0.2.0'
})

// ========== 服务管理 8 工具 ==========

server.tool(
  'pws_list_services',
  '列出所有受管服务的当前状态',
  {},
  async () => textJson(svc.list())
)
server.tool(
  'pws_start_service',
  '按 ID 或名称启动服务',
  { id: z.string().optional(), name: z.string().optional() },
  async ({ id, name }) => {
    const t = resolveService(id, name)
    if (!t) return textResult(`未找到服务: ${id ?? name}`, true)
    return textJson(await svc.startService(t.id, 'mcp', 'start via mcp'))
  }
)
server.tool(
  'pws_stop_service',
  '按 ID 或名称停止服务',
  { id: z.string().optional(), name: z.string().optional() },
  async ({ id, name }) => {
    const t = resolveService(id, name)
    if (!t) return textResult(`未找到服务: ${id ?? name}`, true)
    return textJson(await svc.stop(t.id, 'mcp'))
  }
)
server.tool(
  'pws_restart_service',
  '按 ID 或名称重启服务',
  { id: z.string().optional(), name: z.string().optional() },
  async ({ id, name }) => {
    const t = resolveService(id, name)
    if (!t) return textResult(`未找到服务: ${id ?? name}`, true)
    return textJson(await svc.restart(t.id, 'mcp'))
  }
)
server.tool(
  'pws_service_logs',
  '读取服务最近 N 行日志',
  {
    id: z.string().optional(),
    name: z.string().optional(),
    tail: z.number().int().min(10).max(5000).optional().default(200)
  },
  async ({ id, name, tail: n }) => {
    const t = resolveService(id, name)
    if (!t) return textResult(`未找到服务: ${id ?? name}`, true)
    const r = log.tail(t.id, n)
    return textResult(r.text || '(暂无日志)')
  }
)
server.tool(
  'pws_scan_ports',
  '扫描本机所有 LISTEN 端口',
  {},
  async () => {
    await new Promise((r) => setTimeout(r, 300))
    return textJson(port.snapshot())
  }
)
server.tool(
  'pws_add_service',
  '添加新服务到启动台',
  {
    name: z.string(),
    cwd: z.string(),
    command: z.string(),
    port: z.number().int().optional().nullable(),
    kind: z.enum(['service', 'task']).optional().default('service')
  },
  async ({ name, cwd, command, port: p, kind }) => {
    if (!existsSync(cwd)) return textResult(`工作目录不存在: ${cwd}`, true)
    return textJson(svc.create({ name, cwd, command, port: p ?? null, kind }))
  }
)
server.tool(
  'pws_delete_service',
  '按 ID 或名称删除服务',
  { id: z.string().optional(), name: z.string().optional() },
  async ({ id, name }) => {
    const t = resolveService(id, name)
    if (!t) return textResult(`未找到服务: ${id ?? name}`, true)
    svc.delete(t.id)
    return textResult(`已删除 ${t.name}`)
  }
)

// ========== token-usage 3 工具 ==========

server.tool(
  'pws_query_agent_usage',
  '查询 agent token 用量。agent: codex|claude|opencode|all；model: 模型名；from/to: 毫秒时间戳；granularity: hour|day|month。返回总 token、输入/输出/缓存、缓存命中率、调用次数、按 agent/model/day 分桶、趋势时间序列。',
  {
    agent: z
      .enum(['codex', 'claude', 'opencode', 'all'])
      .optional()
      .default('all'),
    model: z.string().optional(),
    from: z.number().optional(),
    to: z.number().optional(),
    granularity: z.enum(['hour', 'day', 'month']).optional().default('day')
  },
  async (args) => {
    const filter: UsageFilter = {
      agent: args.agent,
      model: args.model,
      from: args.from,
      to: args.to
    }
    const summary = querySummary(filter)
    const timeline = queryTimeline(filter, args.granularity)
    return textJson({ filter, summary, timeline })
  }
)

server.tool(
  'pws_list_agents',
  '列出已发现的所有 agent 平台与模型',
  {},
  async () =>
    textJson({
      agents: listDistinctAgents(),
      models: listDistinctModels(),
      stats: usageScanner.getStats()
    })
)

server.tool(
  'pws_rescan_agents',
  '手动触发全量重扫',
  {},
  async () => textJson(await usageScanner.rescan())
)

// ========== helpers ==========

function resolveService(id?: string, name?: string) {
  if (id) {
    const f = dbGetService(id)
    if (f) return { id: f.id, name: f.name }
  }
  if (name) {
    const f = svc.list().find((s) => s.name === name)
    if (f) return { id: f.id, name: f.name }
  }
  return null
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

function textJson(data: unknown) {
  return textResult(JSON.stringify(data, null, 2))
}

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(
  `[local-console-mcp] 已连接，PID=${process.pid}，数据目录=${userData}，工具数=${11}`
)

process.on('SIGINT', async () => {
  await port.stop()
  await svc.shutdown()
  usageScanner.stop()
  closeDatabase()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await port.stop()
  await svc.shutdown()
  usageScanner.stop()
  closeDatabase()
  process.exit(0)
})
