import type { CalDavSettings } from '../shared/types.js'
import { parseTodos, serializeTodos } from './ics.js'
import type { TaskRecord } from './tasks.js'

function decodeXml(value: string): string {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function tagValue(xml: string, name: string): string {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i')
  const match = pattern.exec(String(xml ?? ''))
  return match === null ? '' : decodeXml(match[1] ?? '')
}

function responseBlocks(xml: string): string[] {
  return [
    ...String(xml ?? '').matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi),
  ].map((match) => match[1] ?? '')
}

function resolveHref(base: string, href: string): string {
  const text = String(href ?? '').trim()
  if (text === '') return ''
  return new URL(text, base).href
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

const PROPFIND_ROOT = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop>
</d:propfind>`

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`

const REPORT_TODOS = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`

export interface RemoteTodo {
  href: string
  etag: string | null
  todo: ReturnType<typeof parseTodos>[number]
}

export interface TaskSyncStore {
  applyRemote(input: {
    accountId: string
    calendarHref: string
    href: string
    etag: string | null
    todo: ReturnType<typeof parseTodos>[number]
  }): TaskRecord | undefined
  pending(accountId: string): TaskRecord[]
  pruneMissingRemote(accountId: string, calendarHref: string, hrefs: string[]): number
  markPushed(id: string, result: { href: string; etag: string | null; uid: string }): TaskRecord | undefined
  purge(id: string): void
  setCalendarState(
    accountId: string,
    state: { calendarHref: string; lastSync: string; error: string | null },
  ): void
}

export interface CalDavSyncResult {
  pulled: number
  pushed: number
  deleted: number
  removed: number
  calendarHref: string
  total: number
}

/**
 * Small CalDAV client for VTODO lists. It uses Node's fetch and
 * XML-by-regular-expression parsing, so it runs on macOS, Windows and Linux.
 */
export class CalDavClient {
  private readonly url: string
  private readonly username: string
  private readonly password: string
  private calendarHref: string

  constructor(config: Partial<CalDavSettings>, password: string) {
    this.url = withSlash(String(config.url ?? '').trim())
    this.username = String(config.username ?? '')
    this.password = String(password ?? '')
    this.calendarHref = String(config.calendarHref ?? '').trim()
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')
    return { Authorization: `Basic ${auth}`, ...extra }
  }

  private async request(
    method: string,
    url: string,
    options: { body?: string; headers?: Record<string, string>; depth?: number } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    if (this.url === '') throw new Error('CalDAV 地址未配置')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, 20_000)
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: this.headers({
          ...(options.depth === undefined ? {} : { Depth: String(options.depth) }),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/xml; charset=utf-8' }),
          ...(options.headers ?? {}),
        }),
        body: options.body,
        signal: controller.signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('CalDAV 连接超时')
      throw new Error(`CalDAV 连接失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (response.status === 401 || response.status === 403)
      throw new Error('CalDAV 认证失败，请检查用户名和应用密码')
    if (response.status === 404) throw new Error('CalDAV 地址或日历不存在')
    if (response.status === 412) throw new Error('CalDAV 任务已被其他客户端修改，请先同步')
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV 返回 ${String(response.status)}${text === '' ? '' : `：${text.slice(0, 160)}`}`)
    }
    return { status: response.status, text, headers: response.headers }
  }

  async discover(): Promise<string> {
    if (this.calendarHref !== '') return this.calendarHref
    const root = await this.request('PROPFIND', this.url, { body: PROPFIND_ROOT, depth: 0 })
    const principalBlock = tagValue(root.text, 'current-user-principal')
    const principal =
      tagValue(principalBlock, 'href') || (principalBlock.trim().startsWith('/') ? principalBlock.trim() : '')
    const homeBlock = tagValue(root.text, 'calendar-home-set')
    let home = tagValue(homeBlock, 'href') || (homeBlock.trim().startsWith('/') ? homeBlock.trim() : '')
    if (home === '') {
      if (principal === '') throw new Error('CalDAV 服务没有返回 calendar-home-set')
      const principalUrl = resolveHref(this.url, principal)
      const principalResponse = await this.request('PROPFIND', principalUrl, {
        body: PROPFIND_ROOT,
        depth: 0,
      })
      const principalHome = tagValue(principalResponse.text, 'calendar-home-set')
      home =
        tagValue(principalHome, 'href') || (principalHome.trim().startsWith('/') ? principalHome.trim() : '')
      if (home === '') throw new Error('CalDAV 服务没有返回日历目录')
    }
    const homeUrl = withSlash(resolveHref(this.url, home))
    const listing = await this.request('PROPFIND', homeUrl, { body: PROPFIND_HOME, depth: 1 })
    const calendars: { href: string; displayName: string }[] = []
    for (const block of responseBlocks(listing.text)) {
      const href = tagValue(block, 'href')
      if (href === '') continue
      if (!/calendar/i.test(tagValue(block, 'resourcetype'))) continue
      const supported = tagValue(block, 'supported-calendar-component-set')
      if (supported !== '' && !/VTODO/i.test(supported)) continue
      calendars.push({
        href: withSlash(resolveHref(homeUrl, href)),
        displayName: tagValue(block, 'displayname') || href,
      })
    }
    if (calendars.length === 0) throw new Error('没有找到支持 VTODO 的任务日历')
    this.calendarHref = calendars[0]?.href ?? ''
    return this.calendarHref
  }

  async listCalendars(): Promise<{ href: string; displayName: string }[]> {
    if (this.calendarHref !== '') return [{ href: this.calendarHref, displayName: '' }]
    const root = await this.request('PROPFIND', this.url, { body: PROPFIND_ROOT, depth: 0 })
    const homeBlock = tagValue(root.text, 'calendar-home-set')
    const home = tagValue(homeBlock, 'href') || (homeBlock.trim().startsWith('/') ? homeBlock.trim() : '')
    if (home === '') throw new Error('CalDAV 服务没有返回日历目录')
    const homeUrl = withSlash(resolveHref(this.url, home))
    const listing = await this.request('PROPFIND', homeUrl, { body: PROPFIND_HOME, depth: 1 })
    return responseBlocks(listing.text)
      .filter((block) => /calendar/i.test(tagValue(block, 'resourcetype')))
      .map((block) => ({
        href: withSlash(resolveHref(homeUrl, tagValue(block, 'href'))),
        displayName: tagValue(block, 'displayname'),
      }))
  }

  async fetchTodos(collectionHref: string): Promise<RemoteTodo[]> {
    const collection = withSlash(resolveHref(this.url, collectionHref))
    const response = await this.request('REPORT', collection, { body: REPORT_TODOS, depth: 1 })
    const items: RemoteTodo[] = []
    for (const block of responseBlocks(response.text)) {
      const href = tagValue(block, 'href')
      if (href === '') continue
      const etag = tagValue(block, 'getetag') || null
      const data = tagValue(block, 'calendar-data')
      if (data === '') continue
      for (const todo of parseTodos(data)) {
        if (todo.uid === '') continue
        items.push({ href: resolveHref(collection, href), etag, todo })
      }
    }
    return items
  }

  async putTodo(
    collectionHref: string,
    task: TaskRecord,
  ): Promise<{ href: string; etag: string | null; uid: string }> {
    const collection = withSlash(resolveHref(this.url, collectionHref))
    const href =
      task.href !== null && task.href !== ''
        ? task.href
        : new URL(`${encodeURIComponent(task.uid)}.ics`, collection).href
    const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
    if (task.etag !== null && task.etag !== '') headers['If-Match'] = task.etag
    else headers['If-None-Match'] = '*'
    const response = await this.request('PUT', href, { body: serializeTodos([task]), headers })
    return { href, etag: response.headers.get('etag') ?? task.etag, uid: task.uid }
  }

  async deleteTodo(href: string, etag: string | null): Promise<void> {
    const headers: Record<string, string> = {}
    if (etag !== null && etag !== '') headers['If-Match'] = etag
    await this.request('DELETE', resolveHref(this.url, href), { headers })
  }

  /** Pull remote VTODOs, then push local dirty/tombstoned tasks. */
  async sync(store: TaskSyncStore, accountId: string): Promise<CalDavSyncResult> {
    const collection = await this.discover()
    const remote = await this.fetchTodos(collection)
    let pulled = 0
    for (const item of remote) {
      store.applyRemote({
        accountId,
        calendarHref: collection,
        href: item.href,
        etag: item.etag,
        todo: item.todo,
      })
      pulled += 1
    }
    const removed = store.pruneMissingRemote(
      accountId,
      collection,
      remote.map((item) => item.href),
    )
    let pushed = 0
    let deleted = 0
    for (const task of store.pending(accountId)) {
      if (task.deleted) {
        if (task.href !== null && task.href !== '') {
          await this.deleteTodo(task.href, task.etag)
          deleted += 1
        }
        store.purge(task.id)
        continue
      }
      const result = await this.putTodo(
        task.calendarHref !== null && task.calendarHref !== '' ? task.calendarHref : collection,
        task,
      )
      store.markPushed(task.id, result)
      pushed += 1
    }
    store.setCalendarState(accountId, {
      calendarHref: collection,
      lastSync: new Date().toISOString(),
      error: null,
    })
    return { pulled, pushed, deleted, removed, calendarHref: collection, total: remote.length }
  }
}
