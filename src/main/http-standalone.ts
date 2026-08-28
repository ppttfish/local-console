/**
 * Standalone HTTP server（无 GUI / 无 Electron）
 * 启动方式：node out/main/http-standalone.cjs
 *   或 ELECTRON_RUN_AS_NODE=1 electron out/main/http-standalone.cjs
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

// 主进程是 CJS 输出，不能用顶层 await，包一层 main。
// 注意这里是源码模块名（rollup 会重写到构建产物的 chunk 路径）
async function main(): Promise<void> {
  const { startHttpServer } = await import('./http-server.js')
  await startHttpServer({ userData, port, rendererDir })
}

void main().catch((e) => {
  console.error('[http-standalone] 启动失败:', e)
  process.exit(1)
})

function resolveUserData(): string {
  const base =
    process.env['LOCAL_CONSOLE_DATA_DIR'] ||
    process.env['LOCALAPPDATA'] ||
    process.env['APPDATA'] ||
    process.cwd()
  return join(base, 'local-console')
}
