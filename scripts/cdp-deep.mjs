import WebSocket from 'ws'
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
let id = 0
const send = (m, p) =>
  new Promise((r) => {
    const myId = ++id
    const h = (d) => {
      const x = JSON.parse(d)
      if (x.id === myId) {
        ws.off('message', h)
        r(x.result)
      }
    }
    ws.on('message', h)
    ws.send(JSON.stringify({ id: myId, method: m, params: p }))
  })
ws.on('open', async () => {
  await new Promise((r) => setTimeout(r, 1500))
  const r = await send('Runtime.evaluate', {
    expression: 'window.lcp.getState.toString()',
    returnByValue: true
  })
  console.log('getState source:')
  console.log(r.result.value)
  ws.close()
  process.exit(0)
})
