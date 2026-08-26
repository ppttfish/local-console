# 插件开发指南

本地总台 v1 已搭好插件架构，v2 起你可以开发自己的插件。

## 插件接口

```ts
// src/main/plugins/types.ts
export interface Plugin {
  id: string                    // 唯一标识，如 'token-usage'
  name: string                  // 中文展示名
  version: string               // 语义化版本
  description: string

  onLoad?(ctx: PluginContext): Promise<void> | void
  onUnload?(): Promise<void> | void

  registerIpc?(ipc: IpcRegistrar): void
  registerMcpTools?(server: McpServer): void
  registerMenu?(menu: MenuRegistrar): void
  registerRoutes?(router: RouteRegistrar): void
  registerStateFilter?(state: AppState): AppState
}

export interface PluginContext {
  db: Database.Database         // better-sqlite3
  bus: EventEmitter             // 主进程事件总线
  appVersion: string
}
```

## 最小插件示例

```ts
// src/main/plugins/builtin/my-plugin/index.ts
import type { Plugin } from '../../types.js'

export const myPlugin: Plugin = {
  id: 'my-plugin',
  name: '我的插件',
  version: '0.1.0',
  description: '示例插件',

  async onLoad(ctx) {
    // 1. 建表
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS my_data (...)`)
    // 2. 订阅事件
    ctx.bus.on('service:status', (ev) => { ... })
  },

  registerMcpTools(server) {
    server.tool('pws_my_query', '...', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }]
    }))
  }
}
```

注册到 `registry.ts` 的 `BUILTIN_PLUGINS` 数组里。

## 暴露给 agent 的 MCP 工具

工具名规范：`pws_<your-plugin>_<action>`，避免冲突。

## 数据库表

插件自己建表；用 `agent_usage` 这种前缀避免和服务表冲突。

## UI 路由

```ts
registerRoutes(router) {
  router.add('/my-page', () => import('./MyPage.vue'))
}
```

然后在 `src/renderer/src/router.ts` 注册一个动态路由（v1.1 提供动态加载 API）。

## 事件总线

主进程会发出这些事件，插件可以监听：

| 事件 | payload |
|---|---|
| `service:status` | `{ service_id, status, pid?, exit_code? }` |
| `service:log` | `{ service_id, text }` |
| `port:changed` | `{ ports: PortSnapshot[] }` |
| `state:changed` | `{}` |
| `alert` | `{ level, message }` |

## 发布

v1 阶段插件必须放进主仓库；v2 起支持从 `~/.local-console/plugins/` 加载第三方插件。
