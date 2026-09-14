/**
 * Worker 路径解析 —— 打包态 Worker 只能从真实文件系统加载
 *
 * 背景（2026-09-14 实测）：
 *  - worker_threads 无法加载 app.asar 内的文件，必须走 asarUnpack 解出的
 *    app.asar.unpacked/out/main/workers/*.cjs；
 *  - 打包后本模块被 rollup 打进 out/main/chunks/*.cjs，__dirname 是
 *    `<resources>/app.asar/out/main/chunks`，而不是 out/main —— 老的
 *    `join(__dirname, 'workers/x.cjs')` 全部落空，getWorkerPath() 返回 null，
 *    于是 worker 被永久禁用、所有重活（DSH 25s 解压、codex 全量解析）回落到
 *    主线程同步执行 → 主进程卡死。
 *  - 另外 Worker 从 app.asar.unpacked 里 require 时 **不会** 回退进 asar
 *    （实测 `Cannot find module 'fzstd'`），所以 Worker 的依赖必须一起 unpack，
 *    见 package.json 的 build.asarUnpack。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 相对于各个候选根目录，worker 可能出现的相对路径 */
const RELATIVE_CANDIDATES = [
  join('out', 'main', 'workers'),
  join('main', 'workers'),
  'workers',
  '.'
]

const cache = new Map<string, string | null>()

function roots(): string[] {
  const out = new Set<string>()
  // __dirname：dev / out/main/index.cjs 时是 out/main；chunk 里是 out/main/chunks
  let dir = __dirname
  for (let i = 0; i < 4; i++) {
    out.add(dir)
    const up = dirname(dir)
    if (!up || up === dir) break
    dir = up
  }
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resources) {
    out.add(join(resources, 'app.asar.unpacked'))
    out.add(join(resources, 'app.asar'))
    out.add(resources)
  }
  return [...out]
}

/**
 * 找到 worker 脚本的真实路径；找不到返回 null（调用方回退到同步实现）。
 * 解包目录（app.asar.unpacked）优先，否则 Worker 起来也会因为依赖解析失败而崩。
 */
export function resolveWorkerPath(fileName: string): string | null {
  const candidates: string[] = []
  for (const root of roots()) {
    for (const rel of RELATIVE_CANDIDATES) {
      const p = join(root, rel, fileName)
      candidates.push(p)
      if (p.includes('app.asar')) {
        candidates.push(p.replace('app.asar', 'app.asar.unpacked'))
      }
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.includes('app.asar.unpacked')) - Number(a.includes('app.asar.unpacked'))
  )
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}

/** 解析 + 缓存（同一个进程内 worker 路径不会变） */
export function workerPath(fileName: string): string | null {
  const hit = cache.get(fileName)
  if (hit !== undefined) return hit
  const p = resolveWorkerPath(fileName)
  cache.set(fileName, p)
  return p
}
