/**
 * SubscriptionRefresher —— 后台定时拉取所有 enabled 订阅
 *  - 每 5 分钟 tick 一次
 *  - 启动首次延迟 3s（错开 UsageScanner）
 *  - 并发用 Promise.all；不阻塞主进程
 *  - 失败写 last_error，不重试；下次 tick 再来
 *  - running flag 防上一次没结束就启动下一轮
 */
import { providers } from './providers/index.js'
import {
  listSubscriptions,
  getSubscription,
  setSubscriptionSnapshot
} from './subscriptions.js'

export class SubscriptionRefresher {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private started = false
  private readonly intervalMs: number
  private readonly firstDelayMs: number

  constructor(intervalMs = 5 * 60 * 1000, firstDelayMs = 3000) {
    this.intervalMs = intervalMs
    this.firstDelayMs = firstDelayMs
  }

  start(): void {
    // 幂等：插件、IPC、HTTP 三个入口都会调 start。
    // 只看 timer 不够 —— 它要到首次延迟结束才赋值，3 秒内被调两次会起两条定时器。
    if (this.started) return
    this.started = true
    setTimeout(() => {
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.intervalMs)
    }, this.firstDelayMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.started = false
  }

  /** 全量 tick：对所有 enabled 订阅并发拉一次 */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const subs = listSubscriptions().filter((s) => s.enabled)
      await Promise.all(subs.map((s) => this.refreshOne(s.id)))
    } finally {
      this.running = false
    }
  }

  /** 单条刷新：被 IPC `SubscriptionRefresh` 直接调用 */
  async refreshOne(id: number): Promise<void> {
    const sub = getSubscription(id)
    if (!sub) return
    const adapter = providers[sub.provider]
    if (!adapter) {
      setSubscriptionSnapshot(id, null, `未知 provider: ${sub.provider}`)
      return
    }
    try {
      const r = await adapter.fetch(sub)
      if (r.ok) {
        setSubscriptionSnapshot(id, r.snapshot, null)
      } else {
        setSubscriptionSnapshot(id, null, r.error)
      }
    } catch (e) {
      setSubscriptionSnapshot(id, null, (e as Error).message)
    }
  }
}

/**
 * 进程级单例。
 * 插件 onLoad、IPC 注册、HTTP server 三个入口都要用刷新器；
 * 各 new 一个的话每条订阅每 5 分钟会被请求三次，既浪费配额又容易触发限流。
 */
export const subscriptionRefresher = new SubscriptionRefresher()
