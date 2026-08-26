// 测 v2：standalone 用 electron.exe 跑，调 pws_list_agents + pws_query_agent_usage
// 验证 omp / zcode / opencode / codex / claude 5 个 agent 都有数据
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
  if (s.includes('已连接') && !ready) {
    ready = true
    setTimeout(() => {
      send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'v2-smoke', version: '0.1.0' }
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
        send('tools/call', { name: 'pws_rescan_agents', arguments: {} })
        send('tools/call', { name: 'pws_query_agent_usage', arguments: { granularity: 'day' } })
        send('tools/call', { name: 'pws_list_agents', arguments: {} })
      } else if (r.id) {
        responses.push(r)
        if (responses.length === 4) {
          for (const r2 of responses) {
            const text = r2.result?.content?.[0]?.text ?? JSON.stringify(r2)
            if (r2.id === 2) {
              const tools = r2.result?.tools ?? []
              const names = tools.map((t) => t.name).sort()
              console.log(`OK 工具数=${tools.length}: ${names.join(', ')}`)
            } else if (r2.id === 3) {
              // rescan 结果
              const obj = JSON.parse(text)
              console.log(`OK rescan: files=${obj.files_scanned} rows=${obj.rows_inserted} errors=${obj.errors}`)
              console.log(`     by_agent: ${JSON.stringify(obj.by_agent)}`)
            } else if (r2.id === 4) {
              // query summary
              const obj = JSON.parse(text)
              const s = obj.summary
              console.log(`OK summary: calls=${s.calls} total=${s.total_tokens} cached=${s.cached_tokens} cost=$${s.cost_usd.toFixed(2)} cache_hit=${s.cache_hit_ratio}%`)
              console.log(`     by_agent:`)
              for (const a of s.by_agent) console.log(`       - ${a.agent}: ${a.calls} calls, $${a.cost.toFixed(4)}`)
              console.log(`     by_model (top 5):`)
              for (const m of s.by_model.slice(0, 5)) console.log(`       - ${m.model}: ${m.calls} calls, $${m.cost.toFixed(4)}`)
              console.log(`     by_day (top 5):`)
              for (const d of s.by_day.slice(-5)) console.log(`       - ${d.day}: ${d.calls} calls, $${d.cost.toFixed(4)}`)
            } else if (r2.id === 5) {
              const obj = JSON.parse(text)
              console.log(`OK list_agents: ${JSON.stringify(obj.agents)}`)
              console.log(`     models: ${obj.models.slice(0, 5).join(', ')}...`)
              console.log(`     stats: ${JSON.stringify(obj.stats)}`)
            }
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
  console.log('TIMEOUT (ready=' + ready + ')')
  child.kill()
  process.exit(2)
}, 60000)
