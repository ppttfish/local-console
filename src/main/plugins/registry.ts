/**
 * 插件注册中心 —— 管理所有插件的加载、卸载、调用。
 * v1 仅内置加载框架；v2 起可热插拔。
 */
import type { EventEmitter } from 'node:events'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../services/db.js'
import { tokenUsagePlugin } from './builtin/token-usage/index.js'
import type {
  Plugin,
  PluginContext,
  IpcRegistrar,
  RouteRegistrar,
  MenuRegistrar
} from './types.js'

const BUILTIN_PLUGINS: Plugin[] = [tokenUsagePlugin]

export class PluginRegistry {
  private plugins = new Map<string, Plugin>()
  private bus: EventEmitter
  private appVersion: string
  private loaded = false

  constructor(bus: EventEmitter, appVersion: string) {
    this.bus = bus
    this.appVersion = appVersion
  }

  private ctx(): PluginContext {
    return { db: getDb(), bus: this.bus, appVersion: this.appVersion }
  }

  async loadAll(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    for (const p of BUILTIN_PLUGINS) {
      await this.load(p)
    }
  }

  async load(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.id)) return
    this.plugins.set(plugin.id, plugin)
    try {
      await plugin.onLoad?.(this.ctx())
    } catch (e) {
      console.error(`[plugin] ${plugin.id} onLoad 失败:`, e)
    }
  }

  async unload(id: string): Promise<void> {
    const p = this.plugins.get(id)
    if (!p) return
    await p.onUnload?.()
    this.plugins.delete(id)
  }

  registerIpc(ipc: IpcRegistrar): void {
    for (const p of this.plugins.values()) {
      try {
        p.registerIpc?.(ipc)
      } catch (e) {
        console.error(`[plugin] ${p.id} registerIpc 失败:`, e)
      }
    }
  }

  registerMcp(server: McpServer): void {
    for (const p of this.plugins.values()) {
      try {
        p.registerMcpTools?.(server)
      } catch (e) {
        console.error(`[plugin] ${p.id} registerMcpTools 失败:`, e)
      }
    }
  }

  registerRoutes(router: RouteRegistrar): void {
    for (const p of this.plugins.values()) {
      try {
        p.registerRoutes?.(router)
      } catch (e) {
        console.error(`[plugin] ${p.id} registerRoutes 失败:`, e)
      }
    }
  }

  registerMenu(menu: MenuRegistrar): void {
    for (const p of this.plugins.values()) {
      try {
        p.registerMenu?.(menu)
      } catch (e) {
        console.error(`[plugin] ${p.id} registerMenu 失败:`, e)
      }
    }
  }

  list(): Array<{ id: string; name: string; version: string; description: string }> {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description
    }))
  }
}
