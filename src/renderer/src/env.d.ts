/// <reference types="vite/client" />

import type { AppState } from '@shared/types'

declare module '*.vue' {
  const component: (typeof import('vue'))['DefineComponent']
  export default component
}

export interface LcpApi {
  listServices: () => Promise<unknown>
  getService: (id: string) => Promise<unknown>
  createService: (input: unknown) => Promise<unknown>
  updateService: (input: unknown) => Promise<unknown>
  deleteService: (id: string) => Promise<unknown>
  startService: (id: string) => Promise<unknown>
  stopService: (id: string) => Promise<unknown>
  restartService: (id: string) => Promise<unknown>
  stopExternalService: (id: string) => Promise<unknown>
  reorderServices: (ids: string[]) => Promise<unknown>
  getServiceLogs: (id: string, tail?: number) => Promise<unknown>
  clearServiceLogs: (id: string) => Promise<unknown>
  resetLogCounter: (id: string) => Promise<unknown>
  detectProject: (cwd: string) => Promise<unknown>
  pickFolder: () => Promise<unknown>
  getState: () => Promise<unknown>
  scanPorts: () => Promise<unknown>
  getAppInfo: () => Promise<unknown>
  openLogDir: () => Promise<unknown>
  openUrl: (url: string) => Promise<unknown>
  openDataDir: () => Promise<unknown>
  quit: () => Promise<unknown>
  usageSummary: (filter: unknown) => Promise<unknown>
  usageTimeline: (args: { filter: unknown; granularity: string }) => Promise<unknown>
  usageModels: () => Promise<unknown>
  usageAgents: () => Promise<unknown>
  usageSessions: (args: { filter: unknown; limit?: number }) => Promise<unknown>
  usageRescan: () => Promise<unknown>
  usageStatus: () => Promise<unknown>
  usageRecap: () => Promise<unknown>

  // 订阅监控
  subList: () => Promise<unknown>
  subGet: (id: number) => Promise<unknown>
  subCreate: (input: unknown) => Promise<unknown>
  subUpdate: (input: unknown) => Promise<unknown>
  subDelete: (id: number) => Promise<unknown>
  subRefresh: (id: number) => Promise<unknown>
  subProviders: () => Promise<unknown>
  subDiscover: () => Promise<unknown>
  onStateChanged: (cb: (s: AppState) => void) => () => void
  onServiceLog: (cb: (p: { id: string; text: string }) => void) => () => void
}

declare global {
  interface Window {
    lcp: LcpApi
  }
}

export {}
