/**
 * 插件契约 —— 任何第三方（或内置）插件都实现这个接口。
 * v1 只搭骨架；v2 起会陆续填充每个 hook 的实现。
 */
import type { EventEmitter } from 'node:events'
import type Database from 'better-sqlite3'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BrowserWindow } from 'electron'
import type { AppState } from '@shared/types'

export interface PluginContext {
  db: Database.Database
  bus: EventEmitter
  appVersion: string
}

export interface IpcRegistrar {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void
}

export interface McpRegistrar {
  // 简化暴露：插件用 server.tool() 自行注册
  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  ): void
}

export interface RouteRegistrar {
  add(path: string, component: () => Promise<unknown>): void
}

export interface MenuRegistrar {
  add(item: { label: string; click: () => void }): void
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string

  onLoad?(ctx: PluginContext): Promise<void> | void
  onUnload?(): Promise<void> | void

  registerIpc?(ipc: IpcRegistrar): void
  registerMcpTools?(server: McpServer): void
  registerMenu?(menu: MenuRegistrar): void
  registerRoutes?(router: RouteRegistrar): void
  registerStateFilter?(state: AppState): AppState
}
