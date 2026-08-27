/**
 * 渲染端 web 模式桥接 —— 没有 window.lcp（preload）时走 fetch
 * 注入方式：在 index.html 里 <script src="./web-bridge.js"></script>
 *   或在 main.ts 里 import './web-bridge' 副作用
 *
 * 当 `window.lcp` 已存在（Electron preload 模式），什么都不做；
 * 否则创建 window.lcp，全部走 fetch 调用 http://127.0.0.1:9600/api/*
 */
import type { AppState } from '@shared/types'
import type { LcpApi } from './env'

declare global {
  interface Window {
    lcp: LcpApi
  }
}

function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then((r) => {
    if (!r.ok) throw new Error(`${path} -> ${r.status}`)
    return r.json() as Promise<T>
  })
}

export function installWebBridge(): void {
  if ((window as unknown as { lcp?: unknown }).lcp) return

  const api: LcpApi = {
    listServices: () => post('/api/service/list'),
    getService: (id) => post(`/api/service/get?id=${encodeURIComponent(id)}`),
    createService: (input) => post('/api/service/create', input),
    updateService: (input) => post('/api/service/update', input),
    deleteService: (id) =>
      post('/api/service/delete', { id }).then(() => ({ ok: true })),
    // post() 无 body 时退化为 GET，而控制类路由只认 POST，必须显式传空 body
    startService: (id) => post(`/api/service/${id}/start`, {}),
    stopService: (id) => post(`/api/service/${id}/stop`, {}),
    restartService: (id) => post(`/api/service/${id}/restart`, {}),
    stopExternalService: (id) => post('/api/service/stop-external', { id }),
    reorderServices: (ids) => post('/api/service/reorder', { ids }),
    getServiceLogs: (id, tail = 300) =>
      post('/api/service/logs', { id, tail }),
    clearServiceLogs: (id) =>
      post('/api/service/clear-logs', { id }).then(() => ({ ok: true })),
    detectProject: (cwd) => post('/api/project/detect', { cwd }),
    pickFolder: () => post('/api/project/pick-folder'),
    getState: () => post('/api/state'),
    scanPorts: () => post('/api/port/scan'),
    getAppInfo: () => post('/api/app/info'),
    openLogDir: () => post('/api/app/open-log-dir'),
    // web 模式直接开新窗口，不必经服务端
    openUrl: (url) => { window.open(url, '_blank'); return Promise.resolve({ ok: true }) },
    openDataDir: () => post('/api/app/open-data-dir'),
    quit: () => post('/api/app/quit'),
    usageSummary: (filter) => post('/api/usage/summary', filter),
    usageTimeline: (args) => post('/api/usage/timeline', args),
    usageModels: () => post('/api/usage/models'),
    usageAgents: () => post('/api/usage/agents'),
    usageSessions: (args) => post('/api/usage/sessions', args),
    usageRescan: () => post('/api/usage/rescan'),
    usageStatus: () => post('/api/usage/status'),
    usageRecap: () => post('/api/usage/recap'),

    // 订阅监控
    subList: () => post('/api/subscription/list'),
    subGet: (id: number) =>
      post(`/api/subscription/get?id=${encodeURIComponent(String(id))}`),
    subCreate: (input) => post('/api/subscription/create', input),
    subUpdate: (input) => post('/api/subscription/update', input),
    subDelete: (id) =>
      post('/api/subscription/delete', { id }).then(() => ({ ok: true })),
    subRefresh: (id) => post('/api/subscription/refresh', { id }),
    subProviders: () => post('/api/subscription/providers'),
    subDiscover: () => post('/api/subscription/discover'),
    onStateChanged: (_cb: (s: AppState) => void) => {
      // 简易轮询代替 IPC 推送
      return () => {
        // 真实场景下用 SSE 或 WebSocket；这里返回空 unsub
      }
    },
    onServiceLog: (_cb: (p: { id: string; text: string }) => void) => {
      return () => {
        // 同上
      }
    }
  }

  window.lcp = api
}
