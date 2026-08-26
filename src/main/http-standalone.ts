/**
 * Standalone HTTP server（无 GUI / 无 Electron）
 * 启动方式：node out/main/http-standalone.js
 *   或 ELECTRON_RUN_AS_NODE=1 electron out/main/http-standalone.js
 */
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// standalone 模式自己拿 userData
const userData = resolveUserData()
if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
const logsDir = join(userData, 'logs')
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

// renderer 目录：build 后在 out/renderer
const rendererDir = resolve('out/renderer')
if (!existsSync(rendererDir)) {
  console.error('[http-standalone] 找不到 out/renderer 目录，请先 npm run build')
  process.exit(1)
}

const port = parseInt(
  process.env['PORT'] ?? process.env['LCP_PORT'] ?? '9600',
  10
)

const { startHttpServer } = await import('./http-server.js')

await startHttpServer({ userData, port, rendererDir })

function resolveUserData(): string {
  const base =
    process.env['LOCAL_CONSOLE_DATA_DIR'] ||
    process.env['LOCALAPPDATA'] ||
    process.env['APPDATA'] ||
    process.cwd()
  return join(base, 'local-console')
}
