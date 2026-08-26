/**
 * 从 Electron 主进程 spawn 一个 MCP standalone 子进程。
 * stdio 模式让 Claude/Codex 等客户端可以直接连进来。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

let mcpProc: ChildProcess | null = null

export function startMcpSubprocess(): void {
  if (mcpProc) return

  // 路径解析：开发期 vs 打包后
  const candidates = [
    join(app.getAppPath(), 'out', 'main', 'mcp', 'standalone.js'),
    join(process.resourcesPath || '', 'app', 'out', 'main', 'mcp', 'standalone.js')
  ]
  const script = candidates.find((p) => existsSync(p))
  if (!script) {
    console.warn('[mcp] standalone.js 未找到，先 build 后再启')
    return
  }

  mcpProc = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  mcpProc.stdout?.on('data', (d) =>
    console.log(`[mcp-stdout] ${d.toString().trim()}`)
  )
  mcpProc.stderr?.on('data', (d) =>
    console.error(`[mcp-stderr] ${d.toString().trim()}`)
  )
  mcpProc.on('exit', (code) => {
    console.log(`[mcp] 子进程退出 code=${code}`)
    mcpProc = null
  })
  mcpProc.on('error', (err) => {
    console.error('[mcp] 启动失败', err)
    mcpProc = null
  })

  app.on('before-quit', () => {
    if (mcpProc) mcpProc.kill()
  })
}
