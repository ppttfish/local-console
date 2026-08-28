/**
 * 用系统默认浏览器打开本机服务地址。
 * 控制台 HTTP API 绑定 127.0.0.1 且 CORS 全开，若不限制协议与主机，
 * 任意本地网页都能借它打开任意 URL（钓鱼跳板），所以只放行本机 http/https。
 */
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

/**
 * 在文件管理器里打开本机目录。
 * 只接受绝对路径，且路径必须真实存在 —— HTTP API 对局域网内任意来源开放，
 * 不能让它变成"在机器上打开任意路径"的入口。
 */
export async function openLocalPath(
  dir: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!isAbsolute(dir)) return { ok: false, error: '仅支持绝对路径' }
    if (!existsSync(dir)) return { ok: false, error: `目录不存在: ${dir}` }
    await shell.openPath(dir)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function openLocalUrl(
  url: string
): Promise<{ ok: boolean; error?: string }> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, error: `无效 URL: ${url}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 地址' }
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return { ok: false, error: '仅允许打开本机（127.0.0.1 / localhost）地址' }
  }
  try {
    await shell.openExternal(u.toString())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
