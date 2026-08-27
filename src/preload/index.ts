/**
 * Preload —— contextBridge 把受限 API 暴露给渲染端。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '../shared/ipc-channels.js'

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  // 服务
  listServices: () => invoke(IpcChannels.ServiceList),
  getService: (id: string) => invoke(IpcChannels.ServiceGet, id),
  createService: (input: unknown) => invoke(IpcChannels.ServiceCreate, input),
  updateService: (input: unknown) => invoke(IpcChannels.ServiceUpdate, input),
  deleteService: (id: string) => invoke(IpcChannels.ServiceDelete, id),
  startService: (id: string) => invoke(IpcChannels.ServiceStart, id),
  stopService: (id: string) => invoke(IpcChannels.ServiceStop, id),
  restartService: (id: string) => invoke(IpcChannels.ServiceRestart, id),
  stopExternalService: (id: string) => invoke(IpcChannels.ServiceStopExternal, id),
  reorderServices: (ids: string[]) => invoke(IpcChannels.ServiceReorder, ids),
  getServiceLogs: (id: string, tail = 300) =>
    invoke(IpcChannels.ServiceLogs, { id, tail }),
  clearServiceLogs: (id: string) => invoke(IpcChannels.ServiceClearLogs, id),

  // 项目识别
  detectProject: (cwd: string) => invoke(IpcChannels.ProjectDetect, cwd),
  pickFolder: () => invoke(IpcChannels.ProjectPickFolder),

  // 全局
  getState: () => invoke(IpcChannels.StateGet),
  scanPorts: () => invoke(IpcChannels.PortScan),

  // 系统
  getAppInfo: () => invoke(IpcChannels.AppGetInfo),
  openLogDir: () => invoke(IpcChannels.AppOpenLogDir),
  openUrl: (url: string) => invoke(IpcChannels.AppOpenUrl, url),
  openDataDir: () => invoke(IpcChannels.AppOpenDataDir),
  quit: () => invoke(IpcChannels.AppQuit),

  // token-usage 插件
  usageSummary: (filter: unknown) => invoke(IpcChannels.UsageSummary, filter),
  usageTimeline: (args: { filter: unknown; granularity: string }) =>
    invoke(IpcChannels.UsageTimeline, args),
  usageModels: () => invoke(IpcChannels.UsageModels),
  usageAgents: () => invoke(IpcChannels.UsageAgents),
  usageSessions: (args: { filter: unknown; limit?: number }) =>
    invoke(IpcChannels.UsageSessions, args),
  usageStatus: () => invoke(IpcChannels.UsageStatus),
  usageRecap: () => invoke(IpcChannels.UsageRecap),

  // 订阅监控
  subList: () => invoke(IpcChannels.SubList),
  subGet: (id: number) => invoke(IpcChannels.SubGet, id),
  subCreate: (input: unknown) => invoke(IpcChannels.SubCreate, input),
  subUpdate: (input: unknown) => invoke(IpcChannels.SubUpdate, input),
  subDelete: (id: number) => invoke(IpcChannels.SubDelete, id),
  subRefresh: (id: number) => invoke(IpcChannels.SubRefresh, id),
  subProviders: () => invoke(IpcChannels.SubProviders),
  subDiscover: () => invoke(IpcChannels.SubDiscover),

  // 自动升级
  checkUpdate: () => invoke('app:check-update') as Promise<{
    status: 'no-update' | 'available' | 'dev-skip' | 'error'
    version?: string
    error?: string
  }>,
  getUpdateStatus: () => invoke('app:get-update-status') as Promise<{
    currentVersion: string
    lastCheck: { at: number; result: string; newVersion?: string; error?: string } | null
    downloaded: boolean
    pendingVersion?: string
  }>,

  // 事件订阅
  onStateChanged: (cb: (s: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(IpcChannels.EventStateChanged, handler)
    return () => ipcRenderer.off(IpcChannels.EventStateChanged, handler)
  },
  onServiceLog: (cb: (payload: { id: string; text: string }) => void) => {
    const handler = (_e: unknown, payload: { id: string; text: string }) =>
      cb(payload)
    ipcRenderer.on(IpcChannels.EventServiceLog, handler)
    return () => ipcRenderer.off(IpcChannels.EventServiceLog, handler)
  }
}

contextBridge.exposeInMainWorld('lcp', api)

export type LcpApi = typeof api
