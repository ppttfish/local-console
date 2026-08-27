/**
 * token-usage 插件 v2 —— 完整版
 *  - 6 agent 数据源：omp / zcode / opencode / codex / claude / dsh
 *  - USD 成本 + 缓存分读/写
 *  - 订阅监控：6 个 provider（generic / anthropic / openai / MiniMax / kimi / zcode）
 *  - MCP：pws_query_agent_usage / pws_list_agents / pws_rescan_agents / pws_get_pricing
 *        + pws_list_subscriptions / pws_refresh_subscription / pws_list_subscription_providers
 *  - IPC：summary / timeline / models / agents / sessions / rescan / status / pricing
 *        + subscription:list/get/create/update/delete/refresh/providers
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Plugin } from '../../types.js'
import { UsageScanner } from './scanner.js'
import {
  ensureUsageSchema,
  querySummary,
  queryRecap,
  listDistinctModels,
  listDistinctAgents,
  listSessions,
  queryTimeline,
  type UsageFilter
} from './storage.js'
import { loadPricing, type ModelPrice } from './pricing.js'
import {
  ensureSubscriptionSchema,
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  type CreateSubscriptionInput
} from './subscriptions.js'
import { SubscriptionRefresher } from './refresh.js'
import { listProviderMetas } from './providers/index.js'

const scanner = new UsageScanner()
const subRefresher = new SubscriptionRefresher()

export const tokenUsagePlugin: Plugin = {
  id: 'token-usage',
  name: 'Agent Token 用量统计',
  version: '2.1.0',
  description:
    '统计本机 agent (omp / zcode / opencode / codex / claude / dsh) 的 token 用量、成本与模型分布；监控 AI 服务商订阅配额',


  async onLoad(ctx) {
    ensureUsageSchema()
    ensureSubscriptionSchema()
    loadPricing()
    scanner.start()
    subRefresher.start()
    scanner.on('scanned', (e: unknown) => {
      ctx.bus.emit('token-usage:scanned', e)
    })
    ctx.bus.emit('token-usage:loaded', { ok: true })
  },

  onUnload() {
    scanner.stop()
    subRefresher.stop()
  },

  registerMcpTools(server: McpServer) {
    server.tool(
      'pws_query_agent_usage',
      '查询 agent token 用量与成本。agent: omp|zcode|opencode|codex|claude|dsh|all；model: 模型名；from/to: 毫秒时间戳；granularity: hour|day|month。返回总 token、输入/输出/缓存、缓存命中率、调用次数、USD 成本、按 agent/model/day 分桶、趋势时间序列。',
      {
        agent: z
          .enum(['omp', 'zcode', 'opencode', 'codex', 'claude', 'dsh', 'all'])
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
      'pws_usage_recap',
      '全时段用量回顾（Wrapped）：总 token/成本、首次与最近使用时间、活跃天数、高峰日、本命模型（占比+缓存命中率）、按小时作息分布、每日明细、连续使用天数（当前/最长）。用于年度回顾、成就徽章与作息分析。',
      {},
      async () => textJson(queryRecap())
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

    // ===== 订阅监控 =====
    server.tool(
      'pws_list_subscriptions',
      '列出所有已添加的 AI 服务商订阅及其最新配额快照',
      {},
      async () => textJson({ subscriptions: listSubscriptions() })
    )

    server.tool(
      'pws_refresh_subscription',
      '手动触发某条订阅的立即刷新（按 id）',
      { id: z.number().int().positive() },
      async (args) => {
        await subRefresher.refreshOne(args.id)
        return textJson({ subscription: getSubscription(args.id) })
      }
    )

    server.tool(
      'pws_list_subscription_providers',
      '列出所有支持的 Provider 适配器元信息（id / label / builtin / configSchema）',
      {},
      async () => textJson({ providers: listProviderMetas() })
    )
  }
}

function textJson(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
  }
}

// 显式 re-export
export {
  scanner,
  subRefresher,
  queryRecap,
  type ModelPrice,
  type CreateSubscriptionInput,
  // 给 IPC / HTTP 层用
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription
}
