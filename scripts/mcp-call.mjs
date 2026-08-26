// 调用 pws_list_services / pws_scan_ports 验证可执行
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const child = spawn('node', [resolve('out/main/mcp/standalone.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
})

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
  if (!ready && d.toString().includes('已连接')) {
    ready = true
    setTimeout(() => {
      send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'call-test', version: '0.1.0' }
      })
    }, 100)
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
        // ready
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
        )
        send('tools/call', { name: 'pws_list_services', arguments: {} })
        send('tools/call', { name: 'pws_scan_ports', arguments: {} })
      } else if (r.id) {
        responses.push(r)
        if (responses.length === 2) {
          for (const r2 of responses) {
            const name = r2.result?.content?.[0]?.text ?? JSON.stringify(r2)
            const head = name.slice(0, 200).replace(/\n/g, ' | ')
            console.log(`OK [id=${r2.id}] ${head}${name.length > 200 ? '…' : ''}`)
          }
          child.kill()
          process.exit(0)
        }
      }
    } catch {}
  }
})

child.on('exit', (c) => c && process.exit(c))
setTimeout(() => {
  console.log('TIMEOUT')
  child.kill()
  process.exit(2)
}, 15000)
