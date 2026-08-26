// 调试：把 stderr 全部打印，确认 standalone 起来了
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const ELECTRON = 'F:/local-console/node_modules/electron/dist/electron.exe'
const child = spawn(
  ELECTRON,
  [resolve('out/main/mcp/standalone.js')],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

let ready = false
let buf = ''
let nextId = 0

const send = (method, params) => {
  const id = ++nextId
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'
  )
  return id
}

child.stderr.on('data', (d) => {
  const s = d.toString()
  process.stderr.write('[mcp-err] ' + s)
  if (s.includes('已连接') && !ready) {
    ready = true
    setTimeout(() => {
      send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'usage-smoke', version: '0.1.0' }
      })
    }, 200)
  }
})

const responses = []
child.stdout.on('data', (d) => {
  buf += d.toString()
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.id === 1) {
        send('tools/list')
        send('tools/call', { name: 'pws_list_agents', arguments: {} })
        send('tools/call', {
          name: 'pws_query_agent_usage',
          arguments: { granularity: 'day' }
        })
      } else if (r.id) {
        responses.push(r)
        if (responses.length === 3) {
          for (const r2 of responses) {
            const text = r2.result?.content?.[0]?.text ?? JSON.stringify(r2)
            if (r2.id === 2) {
              const tools = r2.result?.tools ?? []
              const names = tools.map((t) => t.name).sort()
              console.log(`OK 工具数=${tools.length}`)
              console.log(`OK 工具：${names.join(', ')}`)
            } else {
              const head = text.slice(0, 280).replace(/\n/g, ' | ')
              console.log(`OK [id=${r2.id}] ${head}${text.length > 280 ? '…' : ''}`)
            }
          }
          child.kill()
          process.exit(0)
        }
      }
    } catch {}
  }
})

child.on('exit', (c) => {
  console.error('[mcp exit]', c)
  if (c && c !== 0) process.exit(c)
})
setTimeout(() => {
  console.log('TIMEOUT (ready=' + ready + ')')
  child.kill()
  process.exit(2)
}, 15000)
