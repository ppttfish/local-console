// 用 import 跑 v2 standalone（更可靠）
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const url = pathToFileURL(resolve('out/main/mcp/standalone.js')).href

console.error('[test] before import')
try {
  await import(url)
  console.error('[test] import done (will hang on connect, OK)')
} catch (e) {
  console.error('[test] import error:', e.message)
  process.exit(1)
}

setTimeout(async () => {
  console.error('[test] timeout - inspecting DB')
  process.exit(0)
}, 25000)
