/**
 * 用系统默认浏览器打开本机服务地址。
 * 控制台 HTTP API 绑定 127.0.0.1 且 CORS 全开，若不限制协议与主机，
 * 任意本地网页都能借它打开任意 URL（钓鱼跳板），所以只放行本机 http/https。
 */
import { shell } from 'electron'

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

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
