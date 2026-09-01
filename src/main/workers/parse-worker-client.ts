/**
 * parse-worker-client —— 主线程侧的 Worker 封装
 * 失败自动回退到同步解析，保证在 dev 未打包 / Worker 崩溃时仍可工作
 */
import { Worker } from 'node:worker_threads'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let workerDisabled = false

function getWorkerPath(): string | null {
  // CJS 主进程：__dirname 指向 out/main
  // 开发期：src/main/workers 尚未打包，尝试多个候选
  const candidates = [
    join(__dirname, 'workers/parse-worker.cjs'),
    join(__dirname, 'parse-worker.cjs'),
    resolve('out/main/workers/parse-worker.cjs'),
    resolve('src/main/workers/parse-worker.ts')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function ensureWorker(): Worker | null {
  if (workerDisabled) return null
  if (worker) return worker
  const p = getWorkerPath()
  if (!p) {
    workerDisabled = true
    return null
  }
  try {
    // CJS Worker：直接传文件路径
    worker = new Worker(p)
    worker.on('message', (msg: { id: number; ok: boolean; rows?: unknown; error?: string }) => {
      const entry = pending.get(msg.id)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.rows)
      else entry.reject(new Error(msg.error))
    })
    worker.on('error', () => {
      // Worker 崩溃：拒绝所有 pending 并禁用，后续回退同步
      for (const [, ent] of pending) {
        clearTimeout(ent.timer)
        ent.reject(new Error('worker error'))
      }
      pending.clear()
      try { worker?.terminate() } catch {}
      worker = null
      workerDisabled = true
    })
    worker.on('exit', () => {
      worker = null
      // 不永久禁用，允许下次重试
      if (pending.size > 0) {
        for (const [, ent] of pending) {
          clearTimeout(ent.timer)
          ent.reject(new Error('worker exit'))
        }
        pending.clear()
      }
    })
    return worker
  } catch {
    workerDisabled = true
    return null
  }
}

function callWorker<T>(type: 'dsh' | 'codex' | 'codex-file', payload: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error('no worker'))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('worker timeout'))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    w.postMessage({ id, type, ...payload })
  })
}

export function isWorkerAvailable(): boolean {
  return !!ensureWorker()
}

/** 在 Worker 中解析 DSH，失败回退同步 */
export async function parseDshViaWorker(
  filePath: string,
  fallbackSessionId: string,
  fallback: () => Promise<unknown> | unknown
): Promise<unknown> {
  try {
    const rows = await callWorker('dsh', { filePath, fallbackSessionId })
    return rows
  } catch {
    // 回退
    return fallback()
  }
}

export async function parseCodexViaWorker(
  content: string,
  fallbackSessionId: string,
  fallback: () => unknown
): Promise<unknown> {
  try {
    const rows = await callWorker('codex', { content, fallbackSessionId })
    return rows
  } catch {
    return fallback()
  }
}

export async function parseCodexFileViaWorker(
  filePath: string,
  fallbackSessionId: string,
  fallback: () => unknown
): Promise<unknown> {
  try {
    const rows = await callWorker('codex-file', { filePath, fallbackSessionId }, 20000)
    return rows
  } catch {
    return fallback()
  }
}

export function shutdownParseWorker(): void {
  if (worker) {
    try { worker.terminate() } catch {}
    worker = null
  }
  pending.clear()
}
