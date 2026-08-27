/**
 * IPC handlers 总入口
 */
import { ipcMain, dialog, shell, type BrowserWindow, app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getLogDir } from '../utils/paths.js'
import { IpcChannels } from '../../shared/ipc-channels.js'
import { ServiceManager } from '../services/service-manager.js'
import { PortScanner } from '../services/port-scanner.js'
import { LogStreamer } from '../services/log-streamer.js'
import {
  ensureUsageSchema,
  querySummary,
  queryTimeline,
  listDistinctModels,
  listDistinctAgents,
  listSessions
} from '../plugins/builtin/token-usage/storage.js'
import { UsageScanner } from '../plugins/builtin/token-usage/scanner.js'
import {
  ensureSubscriptionSchema,
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  type CreateSubscriptionInput,
  type UpdateSubscriptionInput
} from '../plugins/builtin/token-usage/subscriptions.js'
import { SubscriptionRefresher } from '../plugins/builtin/token-usage/refresh.js'
import { listProviderMetas } from '../plugins/builtin/token-usage/providers/index.js'
import { discoverOpencodeCredentials } from '../plugins/builtin/token-usage/opencode-auth.js'
import { openLocalUrl } from '../utils/open-external.js'
import type { AppState, PortSnapshot, ServiceState } from '@shared/types'
let usageScanner: UsageScanner | null = null
const subRefresher = new SubscriptionRefresher()

export function registerIpcHandlers(
  svc: ServiceManager,
  port: PortScanner,
  log: LogStreamer,
  getWindow: () => BrowserWindow | null
): void {
  // ===== Service =====
  ipcMain.handle(IpcChannels.ServiceList, () => svc.list())
  ipcMain.handle(IpcChannels.ServiceGet, (_e, id: string) => svc.get(id))
  ipcMain.handle(IpcChannels.ServiceCreate, (_e, input) =>
    svc.create(input as Parameters<typeof svc.create>[0])
  )
  ipcMain.handle(IpcChannels.ServiceUpdate, (_e, input) => {
    const { id, ...patch } = input as { id: string } & Record<string, unknown>
    return svc.update(id, patch as Parameters<typeof svc.update>[1])
  })
  ipcMain.handle(IpcChannels.ServiceDelete, (_e, id: string) => {
    svc.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.ServiceStart, (_e, id: string) =>
    svc.startService(id, 'ui')
  )
  ipcMain.handle(IpcChannels.ServiceStop, (_e, id: string) =>
    svc.stop(id, 'ui')
  )
  ipcMain.handle(IpcChannels.ServiceRestart, (_e, id: string) =>
    svc.restart(id, 'ui')
  )
  ipcMain.handle(IpcChannels.ServiceReorder, (_e, ids: string[]) => {
    svc.reorder(ids)
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.ServiceStopExternal, (_e, id: string) =>
    svc.stopExternal(id, 'ui')
  )

  // ===== Logs =====
  ipcMain.handle(
    IpcChannels.ServiceLogs,
    (_e, payload: { id: string; tail?: number }) =>
      log.tail(payload.id, payload.tail ?? 300)
  )
  ipcMain.handle(IpcChannels.ServiceClearLogs, (_e, id: string) => {
    log.clear(id)
    return { ok: true }
  })

  // ===== Project =====
  ipcMain.handle(IpcChannels.ProjectDetect, (_e, cwd: string) =>
    svc.detectProject(cwd)
  )
  ipcMain.handle(IpcChannels.ProjectPickFolder, async () => {
    const win = getWindow()
    if (!win) return { ok: false, canceled: true }
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) {
      return { ok: true, canceled: true }
    }
    return { ok: true, path: r.filePaths[0] }
  })

  // ===== State =====
  svc.setPortProvider(() => port.snapshot())
  ipcMain.handle(IpcChannels.StateGet, (): AppState => {
    const services = svc.list() as ServiceState[]
    const ports = port.snapshot() as PortSnapshot[]
    const mem = process.memoryUsage()
    return {
      services,
      ports,
      total_cpu: 0,
      total_mem: (mem.rss / 1024 / 1024 / 1024) * 10,
      alerts: [],
      captured_at: Date.now()
    }
  })
  ipcMain.handle(IpcChannels.PortScan, () => port.snapshot())

  // ===== System =====
  ipcMain.handle(IpcChannels.AppGetInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    logDir: getLogDir(),
    homeDir: homedir()
  }))
  ipcMain.handle(IpcChannels.AppOpenLogDir, () => {
    void shell.openPath(getLogDir())
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.AppOpenUrl, (_e, url: string) =>
    openLocalUrl(url)
  )
  ipcMain.handle(IpcChannels.AppOpenDataDir, () => {
    void shell.openPath(app.getPath('userData'))
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.AppQuit, () => {
    app.quit()
    return { ok: true }
  })

  // ===== token-usage 插件 =====
  ensureUsageSchema()
  ipcMain.handle(IpcChannels.UsageSummary, (_e, filter) => querySummary(filter))
  ipcMain.handle(
    IpcChannels.UsageTimeline,
    (_e, args: { filter: unknown; granularity: 'hour' | 'day' | 'month' }) =>
      queryTimeline(
        args.filter as Parameters<typeof queryTimeline>[0],
        args.granularity
      )
  )
  ipcMain.handle(IpcChannels.UsageModels, () => listDistinctModels())
  ipcMain.handle(IpcChannels.UsageAgents, () => listDistinctAgents())
  ipcMain.handle(
    IpcChannels.UsageSessions,
    (_e, args: { filter: unknown; limit?: number }) =>
      listSessions(
        args.filter as Parameters<typeof listSessions>[0],
        args.limit ?? 200
      )
  )
  ipcMain.handle(IpcChannels.UsageRescan, async () => {
    if (!usageScanner) usageScanner = new UsageScanner()
    return usageScanner.rescan()
  })
  ipcMain.handle(IpcChannels.UsageStatus, () => {
    if (!usageScanner) usageScanner = new UsageScanner()
    return usageScanner.getStats()
  })

  // ===== 订阅监控 =====
  ensureSubscriptionSchema()
  ipcMain.handle(IpcChannels.SubList, () => listSubscriptions())
  ipcMain.handle(IpcChannels.SubGet, (_e, id: number) => getSubscription(id))
  ipcMain.handle(IpcChannels.SubCreate, (_e, input) =>
    createSubscription(input as CreateSubscriptionInput)
  )
  ipcMain.handle(IpcChannels.SubUpdate, (_e, input) => {
    const { id, ...patch } = input as UpdateSubscriptionInput
    return updateSubscription(id, patch)
  })
  ipcMain.handle(IpcChannels.SubDelete, (_e, id: number) => {
    deleteSubscription(id)
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.SubRefresh, async (_e, id: number) => {
    await subRefresher.refreshOne(id)
    return getSubscription(id)
  })
  ipcMain.handle(IpcChannels.SubProviders, () => listProviderMetas())
  ipcMain.handle(IpcChannels.SubDiscover, () =>
    discoverOpencodeCredentials()
  )


  // 启动 scheduler
  subRefresher.start()

  // 启动 scanner
  usageScanner = new UsageScanner()
  usageScanner.start()
  void join
}
