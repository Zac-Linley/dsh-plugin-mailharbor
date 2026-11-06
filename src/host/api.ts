import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type {
  Account,
  Address,
  AppState,
  AttachmentMeta,
  BackupStatus,
  Draft,
  DraftAttachment,
  MessageDetail,
  MessageSummary,
  NewAccountInput,
  Page,
  SendResult,
  SettingsView,
} from '../shared/types.js'
import { addressOf, formatAddressList, parseAddressList } from './address.js'
import {
  buildAccount,
  normalizeAccount,
  saveAccounts,
  saveSettings,
  type MailHarborConfig,
} from './config.js'
import { BackupEngine } from './backup.js'
import { HttpError, Router, assertTrusted, readJsonBody, sendJson, type RequestContext } from './http.js'
import type { MailHarborRuntime } from './runtime.js'
import type { ImapProvider } from './imap.js'
import { verifySmtp } from './smtp.js'
import { escapeHtml, htmlToText } from './html.js'

export const API_PREFIX = '/mail-plugin/api'

/** Build the request handler the Host mounts at `/mail-plugin`. */
export function createApiHandler(runtime: MailHarborRuntime) {
  const router = buildRouter(runtime)
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(API_PREFIX)) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    const pathname = url.pathname.slice(API_PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (method !== 'GET' && method !== 'HEAD') assertTrusted(req)
      const match = router.match(method, pathname)
      if (match === null) throw new HttpError(404, `未知接口: ${method} ${pathname}`)
      runtime.refresh()
      const context: RequestContext = {
        req,
        res,
        url,
        params: match.params,
        body: () =>
          readJsonBody(req, method === 'POST' && pathname === '/send' ? 25 * 1024 * 1024 : 2 * 1024 * 1024),
      }
      const result = await match.handler(context)
      if (result !== undefined) sendJson(res, 200, result)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof HttpError && error.code !== undefined ? { code: error.code } : {}),
      })
    }
  }
}

function buildRouter(runtime: MailHarborRuntime): Router {
  const router = new Router()

  router.get('/health', () => ({ ok: true, version: VERSION }))

  router.get('/state', () => appState(runtime))

  router.get('/folders', async ({ url }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    if (source === 'server') {
      const provider = runtime.provider(account)
      const boxes = await provider.mailboxes()
      return {
        items: boxes.map((box) => ({ name: box.path, label: box.name, count: box.messages })),
      }
    }
    return { items: runtime.database(account).mailboxes() }
  })

  router.get('/messages', async ({ url }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    const mailbox = url.searchParams.get('mailbox') ?? 'all'
    const query = url.searchParams.get('query') ?? ''
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? runtime.current.render.listLimit)
    if (source === 'server') {
      const items = await listServer(runtime, account, mailbox, query, limit)
      return { ...items, offset: 0, limit }
    }
    const db = runtime.database(account)
    if (mailbox !== 'all' && mailbox !== '') {
      const page = db.list({ mailbox, query, offset, limit })
      return { ...page, items: page.items.map((item) => localSummary(runtime, account, item)) }
    }
    const page = db.list({ mailbox: 'all', query, offset, limit })
    return { ...page, items: page.items.map((item) => localSummary(runtime, account, item)) }
  })

  router.get('/messages/:id', async ({ url, params }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    const mailbox = url.searchParams.get('mailbox') ?? 'INBOX'
    const id = params.id ?? ''
    if (source === 'server') {
      const provider = runtime.provider(account)
      const message = await provider.read(mailbox, Number(id))
      return serverDetail(runtime, account, message, mailbox)
    }
    const detail = runtime.database(account).get(Number(id))
    if (detail === undefined) throw new HttpError(404, '邮件不存在')
    return localDetail(runtime, account, detail)
  })

  router.post('/messages/:id/read', async ({ url, params, body }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    const mailbox = url.searchParams.get('mailbox') ?? 'INBOX'
    const payload = await body()
    const read = payload.read !== false
    if (source === 'server') {
      const provider = runtime.provider(account)
      const result = await provider.setSeen(mailbox, Number(params.id), read)
      return { ok: true, read: result.read }
    }
    const db = runtime.database(account)
    const detail = db.get(Number(params.id))
    if (detail === undefined) throw new HttpError(404, '邮件不存在')
    const store = runtime.readState(account)
    const key = detail.messageId !== '' ? `mid:${detail.messageId}` : `local:${detail.id}`
    store.setUnread(key, !read)
    // Mirror the change to the server when the archived message still exists there.
    if (typeof detail.messageId === 'string' && detail.messageId !== '') {
      try {
        const provider = runtime.provider(account)
        const mailboxName = detail.mailbox === '' ? 'INBOX' : detail.mailbox
        await provider.setSeenByMessageId(mailboxName, detail.messageId, read)
      } catch {
        // Offline or removed on the server: the local record is the source of truth.
      }
    }
    return { ok: true, read }
  })

  router.get('/attachment', async ({ url, res }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    if (source === 'server') {
      const mailbox = url.searchParams.get('mailbox') ?? 'INBOX'
      const uid = Number(url.searchParams.get('uid') ?? 0)
      const part = Number(url.searchParams.get('part') ?? 0)
      const provider = runtime.provider(account)
      const file = await provider.attachment(mailbox, uid, part)
      writeAttachment(res, file.filename, file.contentType, Buffer.from(file.dataBase64, 'base64'))
      return undefined
    }
    const emailId = Number(url.searchParams.get('emailId') ?? 0)
    const attachmentId = Number(url.searchParams.get('attachmentId') ?? 0)
    const file = runtime.database(account).attachment(emailId, attachmentId)
    if (file === undefined) throw new HttpError(404, '附件不存在')
    writeAttachment(res, file.filename, file.contentType, Buffer.from(file.data))
    return undefined
  })

  router.get('/drafts', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    return { items: runtime.drafts(account).list() }
  })

  router.post('/drafts', async ({ url, body }) => {
    const { account } = accountFrom(runtime, url)
    const payload = await body()
    const draft = runtime.drafts(account).save(normalizeDraftInput(payload, account.id))
    return { draft }
  })

  router.delete('/drafts/:id', ({ url, params }) => {
    const { account } = accountFrom(runtime, url)
    const removed = runtime.drafts(account).remove(params.id ?? '')
    if (!removed) throw new HttpError(404, '草稿不存在')
    return { ok: true }
  })

  router.post('/send', async ({ url, body }) => {
    const { account } = accountFrom(runtime, url)
    const payload = await body()
    const result = await sendFromPayload(runtime, account, payload)
    return result
  })

  router.get('/unread', async ({ url }) => {
    const { account } = accountFrom(runtime, url)
    if (!runtime.hasCredentials(account)) {
      return { unread: runtime.readState(account).count(), source: 'local' }
    }
    try {
      const provider = runtime.provider(account)
      const result = await provider.unseen()
      return { unread: result.count, source: 'server' }
    } catch {
      return { unread: runtime.readState(account).count(), source: 'local' }
    }
  })

  router.get('/accounts', () => ({ accounts: runtime.current.accounts }))

  router.post('/accounts', async ({ body }) => {
    const payload = await body()
    const input = payload as unknown as NewAccountInput & { connect?: boolean; remember?: boolean }
    if (typeof input.email !== 'string') throw new HttpError(400, '缺少邮箱地址')
    const password = typeof input.password === 'string' ? input.password : ''
    const config = runtime.current
    const account = buildAccount(input, config.accounts)
    if (password === '') throw new HttpError(400, '请输入密码或应用专用密码')

    if (input.connect !== false) {
      const provider = await verifyImap(account, password)
      await provider.dispose()
      try {
        await verifySmtp(account.smtp, { user: account.username, pass: password })
      } catch {
        // IMAP is the gate; SMTP problems are reported by the connection check.
      }
    }
    runtime.credentials.remember(account, password, input.remember !== false)
    const accounts = [...config.accounts, account]
    saveAccounts(accounts, account.id)
    runtime.refresh()
    return { account, state: appState(runtime) }
  })

  router.patch('/accounts/:id', async ({ params, body }) => {
    const config = runtime.current
    const id = params.id ?? ''
    const existing = config.accounts.find((account) => account.id === id)
    if (existing === undefined) throw new HttpError(404, '账号不存在')
    const payload = await body()
    const merged = {
      ...existing,
      label: typeof payload.label === 'string' ? payload.label : existing.label,
      username: typeof payload.username === 'string' ? payload.username : existing.username,
      imap: { ...existing.imap, ...asObject(payload.imap) },
      smtp: { ...existing.smtp, ...asObject(payload.smtp) },
      caldav:
        payload.caldav === null
          ? null
          : payload.caldav === undefined
            ? existing.caldav
            : { ...asObject(payload.caldav) },
      enabled: payload.enabled === undefined ? existing.enabled : payload.enabled !== false,
    }
    const account = normalizeAccount(
      merged as Partial<Account>,
      0,
      config.accounts.map((item) => item.id),
    )
    // Preserve the id and creation time; the editor cannot reassign them.
    account.id = existing.id
    account.createdAt = existing.createdAt
    const accounts = config.accounts.map((item) => (item.id === existing.id ? account : item))
    saveAccounts(accounts, config.activeAccountId)
    runtime.invalidate(existing.id)
    return { account }
  })

  router.delete('/accounts/:id', ({ params }) => {
    const config = runtime.current
    const id = params.id ?? ''
    const accounts = config.accounts.filter((account) => account.id !== id)
    if (accounts.length === config.accounts.length) throw new HttpError(404, '账号不存在')
    const active = config.activeAccountId === id ? (accounts[0]?.id ?? null) : config.activeAccountId
    saveAccounts(accounts, active)
    runtime.invalidate(id)
    return { ok: true }
  })

  router.post('/accounts/:id/activate', ({ params }) => {
    const config = runtime.current
    const id = params.id ?? ''
    if (!config.accounts.some((account) => account.id === id)) throw new HttpError(404, '账号不存在')
    saveAccounts(config.accounts, id)
    runtime.refresh()
    return { ok: true, activeAccountId: id }
  })

  router.post('/accounts/:id/login', async ({ params, body }) => {
    const account = accountById(runtime, params.id)
    const payload = await body()
    const password = typeof payload.password === 'string' ? payload.password : ''
    if (password === '') throw new HttpError(400, '请输入密码或应用专用密码')
    const provider = await verifyImap(account, password)
    await provider.dispose()
    const stored = runtime.credentials.remember(account, password, payload.remember !== false)
    return { ok: true, stored: stored.stored }
  })

  router.post('/accounts/:id/logout', ({ params }) => {
    const account = accountById(runtime, params.id)
    runtime.credentials.forget(account)
    runtime.invalidate(account.id)
    return { ok: true }
  })

  router.post('/accounts/:id/check', async ({ params }) => {
    const account = accountById(runtime, params.id)
    const provider = runtime.provider(account)
    const imap = await provider.check()
    let smtp: { ok: boolean; error?: string } = { ok: false }
    try {
      const credentials = runtime.credentialsFor(account)
      await verifySmtp(account.smtp, credentials)
      smtp = { ok: true }
    } catch (error) {
      smtp = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, imap, smtp }
  })

  router.get('/settings', () => settingsView(runtime.current))

  router.patch('/settings', async ({ body }) => {
    const payload = await body()
    const patch: Record<string, unknown> = {}
    if (typeof payload.signature === 'string') patch.signature = payload.signature.slice(0, 5000)
    if (payload.ai !== undefined) patch.ai = asObject(payload.ai)
    if (payload.read !== undefined) patch.read = asObject(payload.read)
    if (payload.render !== undefined) patch.render = asObject(payload.render)
    saveSettings(patch)
    runtime.refresh()
    return { settings: settingsView(runtime.current) }
  })

  router.get('/backup/status', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    return runtime.backupStatus(account)
  })

  router.post('/backup/start', async ({ url }) => {
    const { account } = accountFrom(runtime, url)
    runtime.startBackup(account)
    return { ok: true, status: runtime.backupStatus(account) }
  })

  router.post('/backup/stop', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    const stopped = runtime.stopBackup(account)
    return { ok: stopped, status: runtime.backupStatus(account) }
  })

  return router
}

const VERSION = '0.1.0'

function accountById(runtime: MailHarborRuntime, id: string | undefined): Account {
  const account = runtime.current.accounts.find((item) => item.id === id)
  if (account === undefined) throw new HttpError(404, '账号不存在')
  return account
}

function accountFrom(runtime: MailHarborRuntime, url: URL): { account: Account; config: MailHarborConfig } {
  const requested = url.searchParams.get('accountId')
  const config = runtime.current
  const account =
    requested === null || requested === '' || requested === 'active'
      ? (config.accounts.find((item) => item.id === config.activeAccountId) ?? config.accounts[0])
      : config.accounts.find((item) => item.id === requested)
  if (account === undefined) throw new HttpError(400, '请先添加一个邮箱账号')
  return { account, config }
}

function sourceOf(url: URL): 'local' | 'server' {
  return url.searchParams.get('source') === 'server' ? 'server' : 'local'
}

async function verifyImap(account: Account, password: string): Promise<ImapProvider> {
  const { ImapProvider } = await import('./imap.js')
  const provider = new ImapProvider(account.imap, { user: account.username || account.email, pass: password })
  try {
    await provider.check()
    return provider
  } catch (error) {
    await provider.dispose()
    throw new HttpError(400, `连接失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function appState(runtime: MailHarborRuntime): AppState {
  const config = runtime.current
  const account = config.accounts.find((item) => item.id === config.activeAccountId) ?? null
  return {
    version: VERSION,
    settings: settingsView(config),
    accounts: config.accounts,
    activeAccountId: config.activeAccountId,
    backup: account === null ? emptyBackup() : runtime.backupStatus(account),
    unread: account === null ? 0 : runtime.readState(account).count(),
    loggedIn: account !== null && runtime.hasCredentials(account),
  }
}

function emptyBackup(): BackupStatus {
  return {
    running: false,
    accountId: null,
    startedAt: null,
    finishedAt: null,
    lastSuccessAt: null,
    total: 0,
    added: 0,
    message: '',
    output: [],
    exitCode: null,
  }
}

function settingsView(config: MailHarborConfig): SettingsView {
  return {
    dataDir: config.dataDir,
    configFile: config.configFile,
    signature: config.signature,
    accounts: config.accounts,
    activeAccountId: config.activeAccountId,
    ai: {
      enabled: config.ai.enabled,
      provider: config.ai.provider,
      model: config.ai.model,
      styleSampleCount: config.ai.styleSampleCount,
    },
    read: { markOnOpen: config.read.markOnOpen, pollSeconds: config.read.pollSeconds },
    render: { listLimit: config.render.listLimit },
  }
}

function localSummary(runtime: MailHarborRuntime, account: Account, row: MessageSummary): MessageSummary {
  const store = runtime.readState(account)
  const key = row.messageId !== undefined && row.messageId !== '' ? `mid:${row.messageId}` : `local:${row.id}`
  return { ...row, accountId: account.id, unread: store.isUnread(key), backedUp: true }
}

function localDetail(runtime: MailHarborRuntime, account: Account, detail: MessageDetail): MessageDetail {
  return localSummary(runtime, account, detail) as MessageDetail
}

function serverSummary(
  account: Account,
  message: {
    uid: number
    messageId: string
    subject: string
    from: Address
    to: Address[]
    date: string
    read: boolean
    size: number
  },
  mailbox: string,
  backedUp: boolean,
): MessageSummary {
  return {
    id: String(message.uid),
    accountId: account.id,
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    from: message.from,
    to: message.to,
    date: message.date,
    unread: !message.read,
    flagged: false,
    hasAttachments: false,
    snippet: '',
    size: message.size,
    mailbox,
    backedUp,
  }
}

function serverDetail(
  runtime: MailHarborRuntime,
  account: Account,
  message: {
    uid: number
    messageId: string
    subject: string
    from: Address
    to: Address[]
    cc: Address[]
    date: string
    read: boolean
    size: number
    text: string
    html: string | null
    attachments: AttachmentMeta[]
    inReplyTo: string
    references: string[]
  },
  mailbox: string,
): MessageDetail {
  let backedUp = false
  try {
    backedUp = message.messageId !== '' && runtime.database(account).hasMessageId(message.messageId)
  } catch {
    backedUp = false
  }
  return {
    id: String(message.uid),
    accountId: account.id,
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    replyTo: [],
    date: message.date,
    unread: !message.read,
    flagged: false,
    hasAttachments: message.attachments.length > 0,
    snippet: '',
    size: message.size,
    mailbox,
    backedUp,
    text: message.text,
    html: message.html,
    attachments: message.attachments,
    inReplyTo: message.inReplyTo,
    references: message.references,
  }
}

async function listServer(
  runtime: MailHarborRuntime,
  account: Account,
  mailbox: string,
  query: string,
  limit: number,
): Promise<Omit<Page<MessageSummary>, 'offset' | 'limit'>> {
  const provider = runtime.provider(account)
  const result = await provider.list(mailbox === 'all' ? 'INBOX' : mailbox, Math.min(200, limit * 2))
  let database: ReturnType<MailHarborRuntime['database']> | null = null
  try {
    database = runtime.database(account)
  } catch {
    database = null
  }
  const text = query.trim().toLowerCase()
  const items = result.items
    .filter((message) => {
      if (text === '') return true
      return [message.subject, message.from.name, message.from.address, formatAddressList(message.to)]
        .join(' ')
        .toLowerCase()
        .includes(text)
    })
    .slice(0, limit)
    .map((message) =>
      serverSummary(account, message, mailbox, database?.hasMessageId(message.messageId) ?? false),
    )
  return { items, total: result.total }
}

function writeAttachment(res: ServerResponse, filename: string, contentType: string, data: Buffer): void {
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', String(data.length))
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(data)
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeDraftInput(payload: Record<string, unknown>, accountId: string): Partial<Draft> {
  const attachments: DraftAttachment[] = Array.isArray(payload.attachments)
    ? payload.attachments
        .map((item) => asObject(item))
        .filter((item) => typeof item.filename === 'string' && typeof item.data === 'string')
        .map((item) => ({
          filename: String(item.filename),
          contentType: typeof item.contentType === 'string' ? item.contentType : 'application/octet-stream',
          data: String(item.data),
        }))
    : []
  return {
    ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
    accountId,
    to: stringOf(payload.to),
    cc: stringOf(payload.cc),
    bcc: stringOf(payload.bcc),
    subject: stringOf(payload.subject),
    html: stringOf(payload.html),
    attachments,
    ...(typeof payload.inReplyTo === 'string' ? { inReplyTo: payload.inReplyTo } : {}),
    ...(typeof payload.references === 'string' ? { references: payload.references } : {}),
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function sendFromPayload(
  runtime: MailHarborRuntime,
  account: Account,
  payload: Record<string, unknown>,
): Promise<{ ok: true; result: SendResult }> {
  const to = stringOf(payload.to)
  if (to.trim() === '') throw new HttpError(400, '收件人不能为空')
  const subject = stringOf(payload.subject)
  const html = stringOf(payload.html)
  const text = stringOf(payload.text) !== '' ? stringOf(payload.text) : htmlToText(html)
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments
        .map((item) => asObject(item))
        .filter((item) => typeof item.filename === 'string' && typeof item.data === 'string')
        .map((item) => ({
          filename: String(item.filename),
          contentType:
            typeof item.contentType === 'string' && item.contentType !== ''
              ? item.contentType
              : 'application/octet-stream',
          content: Buffer.from(String(item.data), 'base64'),
        }))
    : []
  const totalBytes = attachments.reduce((sum, file) => sum + file.content.length, 0)
  if (totalBytes > 15 * 1024 * 1024) throw new HttpError(413, '附件合计不能超过 15 MB')

  const { sendMail } = await import('./smtp.js')
  const signature = runtime.current.signature
  const bodyText = signature === '' ? text : `${text}\n\n--\n${signature}`
  const bodyHtml =
    signature === '' ? html : `${html}<p>--</p><p>${escapeHtml(signature).replaceAll('\n', '<br>')}</p>`

  const result = await sendMail(
    account.smtp,
    runtime.credentialsFor(account),
    account.username || account.email,
    {
      to,
      cc: stringOf(payload.cc),
      subject,
      text: bodyText,
      html: bodyHtml,
      ...(typeof payload.inReplyTo === 'string' ? { inReplyTo: payload.inReplyTo } : {}),
      ...(typeof payload.references === 'string' ? { references: payload.references } : {}),
      attachments,
    },
  )
  return { ok: true, result }
}

/** Kept for the tools layer and tests. */
export { addressOf, parseAddressList, randomUUID, backups }

function backups(account: Account, runtime: MailHarborRuntime): BackupStatus {
  return runtime.backupStatus(account)
}

export { htmlToText, escapeHtml, BackupEngine }
