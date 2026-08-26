/**
 * 极简 HTTP 客户端 —— 零依赖（用 node:https / node:http）
 * 用于 Provider 配额接口拉取。8s 默认超时，错误抛 Error 带状态码。
 */
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

export interface HttpError extends Error {
  statusCode?: number
  body?: string
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 8000
): Promise<unknown> {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
  const opts: RequestOptions = {
    method: 'GET',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    headers: { Accept: 'application/json', ...headers }
  }

  return new Promise<unknown>((resolve, reject) => {
    const req = lib(opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const code = res.statusCode ?? 0
        if (code >= 200 && code < 300) {
          try {
            resolve(body.length === 0 ? null : JSON.parse(body))
          } catch (e) {
            const err: HttpError = new Error(
              `JSON 解析失败: ${(e as Error).message}`
            )
            err.statusCode = code
            err.body = body.slice(0, 500)
            reject(err)
          }
        } else {
          const err: HttpError = new Error(
            `HTTP ${code} ${res.statusMessage ?? ''}`.trim()
          )
          err.statusCode = code
          err.body = body.slice(0, 500)
          reject(err)
        }
      })
    })
    req.on('error', (e) => reject(new Error(`网络错误: ${e.message}`)))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'))
    })
    req.end()
  })
}
