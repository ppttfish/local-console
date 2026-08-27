/**
 * 全局状态聚合 —— 一个 store 管所有页面需要的数据。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  AppState,
  ServiceState,
  PortSnapshot
} from '@shared/types'

export interface Toast {
  id: number
  kind: 'error' | 'success'
  text: string
}

export const useAppStore = defineStore('app', () => {
  const services = ref<ServiceState[]>([])
  const ports = ref<PortSnapshot[]>([])
  const totalCpu = ref(0)
  const totalMem = ref(0)
  const alerts = ref<AppState['alerts']>([])
  const capturedAt = ref(0)
  const ready = ref(false)
  const theme = ref<'light' | 'dark' | 'auto'>('auto')

  // 轻量通知：服务操作失败必须可见，否则按钮像"没反应"
  const toasts = ref<Toast[]>([])
  let toastSeq = 1
  function notify(kind: Toast['kind'], text: string): void {
    const id = toastSeq++
    toasts.value.push({ id, kind, text })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, 6000)
  }
  function reportResult(r: unknown): void {
    const res = r as { ok?: boolean; error?: string } | null
    if (res && typeof res === 'object' && res.ok === false && res.error) {
      notify('error', res.error)
    }
  }
  const appInfo = ref<{
    name: string
    version: string
    dataDir: string
    logDir: string
  } | null>(null)

  const runningServices = computed(() =>
    services.value.filter((s) => s.status === 'running')
  )
  const stoppedServices = computed(() =>
    services.value.filter((s) => s.status === 'stopped')
  )
  const unmanagedPorts = computed(() =>
    ports.value.filter((p) => p.app_id === null)
  )

  async function bootstrap(): Promise<void> {
    const info = (await window.lcp.getAppInfo()) as typeof appInfo.value
    appInfo.value = info
    const state = (await window.lcp.getState()) as AppState
    applyState(state)
    ready.value = true
  }

  function applyState(s: AppState): void {
    services.value = s.services
    ports.value = s.ports
    totalCpu.value = s.total_cpu
    totalMem.value = s.total_mem
    alerts.value = s.alerts
    capturedAt.value = s.captured_at
  }

  async function refresh(): Promise<void> {
    const s = (await window.lcp.getState()) as AppState
    applyState(s)
  }

  async function startService(id: string): Promise<unknown> {
    const r = await window.lcp.startService(id)
    reportResult(r)
    return r
  }
  async function stopService(id: string): Promise<unknown> {
    const r = await window.lcp.stopService(id)
    reportResult(r)
    return r
  }
  async function restartService(id: string): Promise<unknown> {
    const r = await window.lcp.restartService(id)
    reportResult(r)
    return r
  }
  async function stopExternalService(id: string): Promise<unknown> {
    const r = await window.lcp.stopExternalService(id)
    reportResult(r)
    return r
  }
  /** 外部进程「重启」：结束占用端口的进程 → 等端口释放 → 用本台命令接管拉起 */
  async function restartExternalService(id: string): Promise<unknown> {
    const r = (await window.lcp.stopExternalService(id)) as {
      ok?: boolean
      error?: string
    }
    if (r && r.ok === false) return r
    for (let i = 0; i < 12; i++) {
      await refresh()
      const svc = services.value.find((s) => s.id === id)
      if (!svc || !svc.listening) break
      await new Promise((res) => setTimeout(res, 500))
    }
    return startService(id)
  }
  async function createService(input: unknown): Promise<unknown> {
    return window.lcp.createService(input)
  }
  async function updateService(input: unknown): Promise<unknown> {
    return window.lcp.updateService(input)
  }
  async function deleteService(id: string): Promise<unknown> {
    const r = await window.lcp.deleteService(id)
    reportResult(r)
    return r
  }
  async function reorderServices(ids: string[]): Promise<unknown> {
    return window.lcp.reorderServices(ids)
  }
  async function getLogs(id: string, tail = 300): Promise<unknown> {
    return window.lcp.getServiceLogs(id, tail)
  }
  async function clearLogs(id: string): Promise<unknown> {
    return window.lcp.clearServiceLogs(id)
  }
  async function detectProject(cwd: string): Promise<unknown> {
    return window.lcp.detectProject(cwd)
  }
  async function pickFolder(): Promise<unknown> {
    return window.lcp.pickFolder()
  }
  async function openDataDir(): Promise<unknown> {
    return window.lcp.openDataDir()
  }
  async function openLogDir(): Promise<unknown> {
    return window.lcp.openLogDir()
  }
  async function quit(): Promise<unknown> {
    return window.lcp.quit()
  }

  return {
    services,
    ports,
    totalCpu,
    totalMem,
    alerts,
    capturedAt,
    ready,
    theme,
    appInfo,
    toasts,
    notify,
    runningServices,
    stoppedServices,
    unmanagedPorts,
    bootstrap,
    applyState,
    refresh,
    startService,
    stopService,
    restartService,
    stopExternalService,
    restartExternalService,
    createService,
    updateService,
    deleteService,
    reorderServices,
    getLogs,
    clearLogs,
    detectProject,
    pickFolder,
    openDataDir,
    openLogDir,
    quit
  }
})
