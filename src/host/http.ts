import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

export function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof HttpError ? error.code : undefined
  sendJson(res, status, { error: message, ...(code === undefined ? {} : { code }) })
}

/** Read a JSON request body with a hard size cap. */
export async function readJsonBody(
  req: IncomingMessage,
  limit = 2 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, '请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/**
 * Reject cross-site writes. The Host only listens on loopback, so a request
 * whose Origin is a web page on another site is a CSRF attempt; the desktop
 * shell uses the `dsh-app:` origin and is accepted explicitly.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  if (origin.startsWith('dsh-app://')) return true
  try {
    const parsed = new URL(origin)
    const host = req.headers.host ?? ''
    return parsed.host === host
  } catch {
    return false
  }
}

export function assertTrusted(req: IncomingMessage): void {
  if (!isTrustedRequest(req)) throw new HttpError(403, '来源不被允许', 'forbidden')
}

export interface RouteMatch {
  handler: RouteHandler
  params: Record<string, string>
  path: string
}

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: () => Promise<Record<string, unknown>>
}

export type RouteHandler = (context: RequestContext) => Promise<unknown> | unknown

interface Route {
  method: string
  segments: string[]
  handler: RouteHandler
}

/** Tiny method + path router with `:param` segments. */
export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter((segment) => segment !== ''),
      handler,
    })
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler)
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler)
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler)
  }

  match(method: string, pathname: string): RouteMatch | null {
    const parts = pathname.split('/').filter((segment) => segment !== '')
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (const [index, segment] of route.segments.entries()) {
        const actual = parts[index] ?? ''
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(actual)
        } else if (segment !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { handler: route.handler, params, path: pathname }
    }
    return null
  }
}
