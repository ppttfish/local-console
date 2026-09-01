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

/**
 * 按 id 合并服务列表：内容相同的条目沿用旧对象引用。
 * 2 秒一次的快照里绝大多数服务状态没变，让 Vue 的 props 比较直接命中跳过。
 */
function mergeById(prev: ServiceState[], next: ServiceState[]): ServiceState[] {
  if (prev.length !== next.length) return next
  const byId = new Map(prev.map((s) => [s.id, s]))
  let allSame = true
  const out = next.map((s) => {
    const old = byId.get(s.id)
    if (!old) {
      allSame = false
      return s
    }
    // 运行中的服务 uptime_sec 每轮都在变，会自然产生新对象 —— 这是对的，
    // 卡片上要显示实时运行时长；已停止的服务则沿用旧引用，跳过重渲染
    if (sameService(old, s)) return old
    allSame = false
    return s
  })
  return allSame ? prev : out
}

function sameService(a: ServiceState, b: ServiceState): boolean {
  return (
    a.status === b.status &&
    a.pid === b.pid &&
    a.uptime_sec === b.uptime_sec &&
    a.listening === b.listening &&
    a.port_occupied_pid === b.port_occupied_pid &&
    a.port_process_name === b.port_process_name &&
    a.last_exit_code === b.last_exit_code &&
    a.mem_mb === b.mem_mb &&
    a.updated_at === b.updated_at &&
    a.name === b.name &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.port === b.port
  )
}

function samePorts(a: PortSnapshot[], b: PortSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.port !== y.port ||
      x.pid !== y.pid ||
      x.process_name !== y.process_name ||
      x.app_id !== y.app_id ||
      x.cmd !== y.cmd
    ) {
      return false
    }
  }
  return true
}

export const useAppStore = defineStore('app', () => {
  const services = ref<ServiceState[]>([])
  const ports = ref<PortSnapshot[]>([])
  /** 托管进程占用的物理内存合计（MB）；0 表示当前没有可统计的运行中进程 */
  const totalMemMb = ref(0)
  const alerts = ref<AppState['alerts']>([])
  const capturedAt = ref(0)
  const ready = ref(false)
  const theme = ref<'light' | 'dark' | 'auto'>('auto')

  /** 内存占用 30 采样滚动窗口（Monitor 页趋势用） */
  const metricWindow = 30
  const memHistory = ref<number[]>([])

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
    homeDir?: string
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

  /**
   * 写入新快照。
   * 主进程现在会主动推状态，加上渲染端轮询，同一个快照可能一秒内来两三次；
   * 内容没变时逐个字段浅比较后复用旧对象引用，避免每张 ServiceCard
   * 都因为 props 引用变化重渲染一遍。
   */
  function applyState(s: AppState): void {
    services.value = mergeById(services.value, s.services)
    ports.value = samePorts(ports.value, s.ports) ? ports.value : s.ports
    totalMemMb.value = s.total_mem_mb
    alerts.value = s.alerts
    capturedAt.value = s.captured_at
    memHistory.value.push(s.total_mem_mb)
    if (memHistory.value.length > metricWindow) memHistory.value.shift()
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
  /** 在系统浏览器打开该服务的本机端口地址（web 应用一键访问） */
  async function openServiceInBrowser(svc: ServiceState): Promise<unknown> {
    if (!svc.port) {
      notify('error', '该条目未配置端口，无法打开')
      return { ok: false, error: '该条目未配置端口' }
    }
    const r = await window.lcp.openUrl(`http://127.0.0.1:${svc.port}`)
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
  async function getLogs(id: string, tail = 300, force?: boolean): Promise<unknown> {
    return window.lcp.getServiceLogs(id, tail, force)
  }
  async function clearLogs(id: string): Promise<unknown> {
    const r = await window.lcp.clearServiceLogs(id)
    // 主进程侧的内存字节计数也要归零，否则清空后会很快触发一次轮转
    await window.lcp.resetLogCounter?.(id)
    return r
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
    totalMemMb,
    memHistory,
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
    openServiceInBrowser,
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
