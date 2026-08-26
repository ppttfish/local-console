// 直接 import standalone 看会不会卡住
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

console.error('[test] before import')
const url = pathToFileURL(resolve('out/main/mcp/standalone.js')).href
await import(url)
console.error('[test] after import - this should print if init done')
setTimeout(() => {
  console.error('[test] timeout exit')
  process.exit(0)
}, 5000)
