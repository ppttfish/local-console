// MCP 冒烟测试：spawn standalone，等 stderr 出现 "已连接" 再发请求
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const child = spawn('node', [resolve('out/main/mcp/standalone.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
})

let ready = false
let buf = ''

child.stderr.on('data', (d) => {
  const s = d.toString()
  process.stderr.write('[mcp-stderr] ' + s)
  if (!ready && s.includes('已连接')) {
    ready = true
    setTimeout(() => {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '0.1.0' }
          }
        }) + '\n'
      )
    }, 100)
  }
})

child.stdout.on('data', (d) => {
  buf += d.toString()
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.id === 1) {
        console.log('OK initialize：server =', r.result?.serverInfo?.name, r.result?.serverInfo?.version)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }) + '\n'
        )
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'
        )
      } else if (r.id === 2) {
        const tools = r.result?.tools ?? []
        const names = tools.map((t) => t.name).sort()
        console.log('OK 工具数：', tools.length)
        console.log('OK 工具：', names.join(', '))
        child.kill()
        process.exit(0)
      } else {
        console.log('  resp:', line.slice(0, 200))
      }
    } catch {
      console.log('  raw:', line.slice(0, 200))
    }
  }
})

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.log('mcp exit:', code)
    process.exit(code)
  }
})

setTimeout(() => {
  console.log('TIMEOUT')
  child.kill()
  process.exit(2)
}, 12000)
