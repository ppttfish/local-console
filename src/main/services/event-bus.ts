/**
 * 事件总线 —— 主进程内部通信。
 * 也用于通过 webContents 推送到渲染端。
 */
import { EventEmitter } from 'node:events'

export type AppEvent =
  | {
      type: 'service:status'
      service_id: string
      status: string
      pid?: number
      exit_code?: number | null
    }
  | { type: 'service:log'; service_id: string; text: string }
  | { type: 'port:changed'; ports: unknown[] }
  | { type: 'state:changed' }
  | { type: 'alert'; level: 'info' | 'warn' | 'error'; message: string }

type EventOfType<T> = Extract<AppEvent, { type: T }>

export class Bus extends EventEmitter {
  emit_event(ev: AppEvent): void {
    this.emit(ev.type, ev)
    this.emit('*', ev)
  }

  on_event<T extends AppEvent['type']>(
    type: T,
    handler: (ev: EventOfType<T>) => void
  ): () => void {
    this.on(type, handler as (...args: unknown[]) => void)
    return () => this.off(type, handler as (...args: unknown[]) => void)
  }
}

export class EventBus extends Bus {}
