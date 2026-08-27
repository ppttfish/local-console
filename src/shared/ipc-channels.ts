/**
 * IPC 通道名常量 —— 跨进程必须严格匹配。
 */
export const IpcChannels = {
  // 服务管理
  ServiceList: 'service:list',
  ServiceGet: 'service:get',
  ServiceCreate: 'service:create',
  ServiceUpdate: 'service:update',
  ServiceDelete: 'service:delete',
  ServiceStart: 'service:start',
  ServiceStop: 'service:stop',
  ServiceRestart: 'service:restart',
  ServiceStopExternal: 'service:stopExternal',
  ServiceReorder: 'service:reorder',
  ServiceLogs: 'service:logs',
  ServiceClearLogs: 'service:clearLogs',

  // 项目识别
  ProjectDetect: 'project:detect',
  ProjectPickFolder: 'project:pickFolder',

  // 全局状态
  StateGet: 'state:get',
  PortScan: 'port:scan',

  // 事件（主 → 渲染）
  EventStateChanged: 'event:stateChanged',
  EventServiceLog: 'event:serviceLog',

  // 系统
  AppQuit: 'app:quit',
  AppOpenLogDir: 'app:openLogDir',
  AppOpenUrl: 'app:openUrl',
  AppOpenDataDir: 'app:openDataDir',
  AppGetInfo: 'app:getInfo',

  // token-usage 插件
  UsageSummary: 'usage:summary',
  UsageTimeline: 'usage:timeline',
  UsageModels: 'usage:models',
  UsageAgents: 'usage:agents',
  UsageSessions: 'usage:sessions',
  UsageRescan: 'usage:rescan',
  UsageStatus: 'usage:status',
  UsageRecap: 'usage:recap',

  // 订阅监控
  SubList: 'subscription:list',
  SubGet: 'subscription:get',
  SubCreate: 'subscription:create',
  SubUpdate: 'subscription:update',
  SubDelete: 'subscription:delete',
  SubRefresh: 'subscription:refresh',
  SubProviders: 'subscription:providers',
  SubDiscover: 'subscription:discover'
 } as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
