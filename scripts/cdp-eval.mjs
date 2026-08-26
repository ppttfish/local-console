// 用 CDP 查渲染端的实际状态
import WebSocket from 'ws'

const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())
const target = list[0]
const wsUrl = target.webSocketDebuggerUrl
console.log('target:', target.title, target.url)
console.log('ws:', wsUrl)

const ws = new WebSocket(wsUrl)
let id = 0
const send = (method, params) => {
  return new Promise((resolve, reject) => {
    const myId = ++id
    const handler = (data) => {
      const msg = JSON.parse(data)
      if (msg.id === myId) {
        ws.off('message', handler)
        if (msg.error) reject(msg.error)
        else resolve(msg.result)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}

ws.on('open', async () => {
  await new Promise((r) => setTimeout(r, 1500)) // 等页面加载

  // 1. 看 window.lcp 是什么
  const r1 = await send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        hasLcp: typeof window.lcp,
        lcpKeys: window.lcp ? Object.keys(window.lcp).slice(0, 10) : null,
        isWebBridge: !!(window.__WEB_BRIDGE__ || (window.lcp && window.lcp.usageSummary && !window.lcp.getState))
      })
    `,
    returnByValue: true
  })
  console.log('window.lcp:', r1.result.value)

  // 2. 直接调 getState
  const r2 = await send('Runtime.evaluate', {
    expression: `
      window.lcp.getState().then(s => JSON.stringify({
        services: s.services.length,
        ports: s.ports.length,
        firstPort: s.ports[0]
      })).catch(e => 'ERR: ' + e.message)
    `,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('getState result:', r2.result.value)

  // 3. 直接调 usageSummary
  const r3 = await send('Runtime.evaluate', {
    expression: `
      window.lcp.usageSummary({agent:'all'}).then(s => JSON.stringify({
        calls: s.calls,
        cost: s.cost_usd,
        byAgentCount: s.by_agent.length
      })).catch(e => 'ERR: ' + e.message)
    `,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('usageSummary result:', r3.result.value)

  // 4. 看 console error
  const r4 = await send('Runtime.evaluate', {
    expression: `JSON.stringify(window.__lastError || 'no')`,
    returnByValue: true
  })
  console.log('lastError:', r4.result.value)

  ws.close()
  process.exit(0)
})
ws.on('error', (e) => {
  console.error('ws error:', e)
  process.exit(1)
})
