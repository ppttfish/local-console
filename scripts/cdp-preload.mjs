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
  await new Promise((r) => setTimeout(r, 2000))
  // 1. 看 preload 是否注册 contextBridge
  const r1 = await send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        hasContextBridge: typeof window.contextBridge,
        electronAPI: typeof window.electronAPI,
        // web-bridge install check
        webBridgeInstalled: !!document.documentElement.dataset.lcpWebBridge
      })
    `,
    returnByValue: true
  })
  console.log('checks:', r1.result.value)

  // 2. 看 console
  const r2 = await send('Runtime.evaluate', {
    expression: `
      // 看 preload 跑过的痕迹
      JSON.stringify({
        docTitle: document.title,
        // 查 lcp 是 IPC 还是 fetch
        getStateSrc: window.lcp.getState.toString().slice(0, 100)
      })
    `,
    returnByValue: true
  })
  console.log('state:', r2.result.value)
  ws.close()
  process.exit(0)
})
