/**
 * token-usage 插件 v2 —— 完整版
 *  - 5 agent 数据源：omp / zcode / opencode / codex / claude
 *  - USD 成本 + 缓存分读/写
 *  - MCP：pws_query_agent_usage / pws_list_agents / pws_rescan_agents / pws_get_pricing
 *  - IPC：summary / timeline / models / agents / sessions / rescan / status / pricing
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Plugin } from '../../types.js'
import { UsageScanner } from './scanner.js'
import {
  ensureUsageSchema,
  querySummary,
  listDistinctModels,
  listDistinctAgents,
  listSessions,
  queryTimeline,
  type UsageFilter
} from './storage.js'
import { loadPricing, type ModelPrice } from './pricing.js'

const scanner = new UsageScanner()

export const tokenUsagePlugin: Plugin = {
  id: 'token-usage',
  name: 'Agent Token 用量统计',
  version: '2.0.0',
  description:
    '统计本机 agent (omp / zcode / opencode / codex / claude) 的 token 用量、成本与模型分布',

  async onLoad(ctx) {
    ensureUsageSchema()
    loadPricing()
    scanner.start()
    scanner.on('scanned', (e: unknown) => {
      ctx.bus.emit('token-usage:scanned', e)
    })
    ctx.bus.emit('token-usage:loaded', { ok: true })
  },

  onUnload() {
    scanner.stop()
  },

  registerMcpTools(server: McpServer) {
    server.tool(
      'pws_query_agent_usage',
      '查询 agent token 用量与成本。agent: omp|zcode|opencode|codex|claude|all；model: 模型名；from/to: 毫秒时间戳；granularity: hour|day|month。返回总 token、输入/输出/缓存、缓存命中率、调用次数、USD 成本、按 agent/model/day 分桶、趋势时间序列。',
      {
        agent: z
          .enum(['omp', 'zcode', 'opencode', 'codex', 'claude', 'all'])
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
      '列出已发现的所有 agent 平台、模型维度、扫描状态',
      {},
      async () =>
        textJson({
          agents: listDistinctAgents(),
          models: listDistinctModels(),
          stats: scanner.getStats()
        })
    )

    server.tool(
      'pws_rescan_agents',
      '手动触发全量重扫（清空 cursor，从头读所有 jsonl + opencode.db）',
      {},
      async () => textJson(await scanner.rescan())
    )

    server.tool(
      'pws_get_pricing',
      '获取当前所有已知模型的 USD 定价（每百万 tokens）',
      {},
      async () => textJson({ models: loadPricing() })
    )
  }
}

function textJson(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
  }
}

// 显式 re-export
export { scanner, type ModelPrice }
