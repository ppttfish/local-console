/**
 * db-worker-client —— 主线程侧 DB 读 Worker 封装
 * 失败自动回退到同步查询，保证 dev 未打包 / Worker 崩溃时仍可工作
 */
import { Worker } from 'node:worker_threads'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { getDbPath } from '../services/db.js'

type Pending = { resolve:(v:unknown)=>void; reject:(e:unknown)=>void; timer:ReturnType<typeof setTimeout> }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let workerDisabled = false
let initPromise: Promise<void> | null = null

function getWorkerPath(): string | null {
  const candidates = [
    join(__dirname, 'workers/db-worker.cjs'),
    join(__dirname, 'db-worker.cjs'),
    resolve('out/main/workers/db-worker.cjs'),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

function ensureWorker(): Worker | null {
  if (workerDisabled) return null
  if (worker) return worker
  const p = getWorkerPath()
  if (!p) { workerDisabled = true; return null }
  try {
    worker = new Worker(p)
    worker.on('message', (msg: { id:number; ok:boolean; result?:unknown; error?:string }) => {
      const ent = pending.get(msg.id)
      if (!ent) return
      clearTimeout(ent.timer)
      pending.delete(msg.id)
      if (msg.ok) ent.resolve(msg.result)
      else ent.reject(new Error(msg.error))
    })
    worker.on('error', () => {
      for (const [,e] of pending){ clearTimeout(e.timer); e.reject(new Error('db worker error')) }
      pending.clear()
      try{ worker?.terminate()}catch{} worker=null; workerDisabled=true
    })
    worker.on('exit',()=>{ worker=null; if(pending.size){ for(const [,e] of pending){ clearTimeout(e.timer); e.reject(new Error('db worker exit')) } pending.clear() } })
    return worker
  } catch { workerDisabled=true; return null }
}

async function ensureInit(): Promise<boolean> {
  const w = ensureWorker()
  if (!w) return false
  const dbPath = getDbPath()
  if (!dbPath) return false
  // 已初始化过且路径未变，直接复用
  if ((w as unknown as { _dbPath?:string })._dbPath === dbPath) return true
  if (initPromise) { try{ await initPromise }catch{} return (w as unknown as { _dbPath?:string })._dbPath===dbPath }
  initPromise = new Promise<void>((resolve, reject)=>{
    const id = nextId++
    const timer = setTimeout(()=>{ pending.delete(id); reject(new Error('init timeout'))}, 5000)
    pending.set(id, { resolve: ()=>{ (w as unknown as { _dbPath:string })._dbPath=dbPath; resolve() }, reject, timer })
    w.postMessage({ id, type:'init', dbPath })
  })
  try{ await initPromise; return true }catch{ return false } finally { initPromise=null }
}

function callWorker<T>(type:string, payload:Record<string,unknown>, timeoutMs=8000): Promise<T> {
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error('no worker'))
  return ensureInit().then(() => {
    if (!ensureWorker()) throw new Error('no worker after init')
    const id = nextId++
    return new Promise<T>((resolve, reject)=>{
      const timer = setTimeout(()=>{ pending.delete(id); reject(new Error('db worker timeout'))}, timeoutMs)
      pending.set(id, { resolve: resolve as (v:unknown)=>void, reject, timer })
      ensureWorker()!.postMessage({ id, type, ...payload })
    })
  })
}

export async function dbWorkerQuerySummary(filter: unknown): Promise<unknown | null> {
  try{ return await callWorker('summary', { filter }) }catch{ return null }
}
export async function dbWorkerQueryTimeline(filter: unknown, granularity: string): Promise<unknown | null> {
  try{ return await callWorker('timeline', { filter, granularity }) }catch{ return null }
}
export async function dbWorkerListSessions(filter: unknown, limit:number): Promise<unknown | null> {
  try{ return await callWorker('sessions', { filter, limit }) }catch{ return null }
}
export async function dbWorkerQueryRecap(): Promise<unknown | null> {
  try{ return await callWorker('recap', {}) }catch{ return null }
}
export async function dbWorkerCountLegacy(): Promise<number | null> {
  try{ return await callWorker<number>('legacy', {}) }catch{ return null }
}

export function isDbWorkerAvailable(): boolean { return !!ensureWorker() && !!getDbPath() }

export function shutdownDbWorker(): void {
  if (worker){ try{ worker.terminate()}catch{} worker=null }
  pending.clear()
}
