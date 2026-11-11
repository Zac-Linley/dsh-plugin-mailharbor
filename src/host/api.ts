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
  Project,
  SendResult,
  Task,
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
import { resolveUserPath } from './paths.js'
import { openPath, pickDirectory } from './picker.js'
import { existsSync, rmSync } from 'node:fs'
import { moveLocalMessage } from './mail-write.js'
import { draftMime } from './draft-mime.js'
import { optimizeDatabase } from './references.js'
import { BackupEngine } from './backup.js'
import { HttpError, Router, assertTrusted, readJsonBody, sendJson, type RequestContext } from './http.js'
import { normalizeTranslated, summaryBlocks, textToHtml } from './ai.js'
import { appendConversation, createProject, type ProjectRecord } from './projects.js'
import type { TaskRecord } from './tasks.js'
import { VERSION } from './version.js'
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
    const source = sourceOf(url)
    const requested = url.searchParams.get('accountId')
    if (source === 'server' && requested === 'all') {
      throw new HttpError(400, '统一收件箱暂只支持本地备份')
    }
    const accounts =
      requested === 'all'
        ? runtime.current.accounts.filter((item) => item.enabled !== false)
        : [accountFrom(runtime, url).account]
    if (source === 'server') {
      const provider = runtime.provider(accounts[0] as Account)
      const boxes = await provider.mailboxes(url.searchParams.get('refresh') === '1')
      return {
        items: boxes.map((box) => ({ name: box.path, label: box.name, count: box.messages })),
      }
    }
    const counts = new Map<string, number>()
    let drafts = 0
    for (const account of accounts) {
      try {
        for (const box of runtime.database(account).mailboxes()) {
          counts.set(box.name, (counts.get(box.name) ?? 0) + box.count)
        }
      } catch {
        // An account without a backup simply contributes no folders.
      }
      try {
        drafts += runtime.drafts(account).list().length
      } catch {
        // Ignore a broken drafts file.
      }
    }
    const items = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
    items.unshift({ name: '__drafts', count: drafts })
    return { items }
  })

  router.get('/messages', async ({ url }) => {
    const source = sourceOf(url)
    const requested = url.searchParams.get('accountId')
    const mailbox = url.searchParams.get('mailbox') ?? 'all'
    const query = url.searchParams.get('query') ?? ''
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? runtime.current.render.listLimit)
    if (requested === 'all') {
      if (source === 'server') throw new HttpError(400, '统一收件箱暂只支持本地备份')
      return listAllAccounts(runtime, { mailbox, query, offset, limit })
    }
    const { account } = accountFrom(runtime, url)
    if (source === 'server') {
      const items = await listServer(runtime, account, mailbox, query, limit, offset)
      return { ...items, offset, limit }
    }
    const unreadOnly = url.searchParams.get('unread') === '1'
    const from = url.searchParams.get('from') ?? ''
    const since = url.searchParams.get('since') ?? ''
    const before = url.searchParams.get('before') ?? ''
    const attachmentsOnly = url.searchParams.get('attachment') === '1'
    const page = runtime.database(account).list({
      mailbox: mailbox === '' ? 'all' : mailbox,
      query,
      offset,
      limit,
      ...(from.trim() === '' ? {} : { from }),
      ...(since === '' ? {} : { since }),
      ...(before === '' ? {} : { before }),
      ...(attachmentsOnly ? { attachmentsOnly: true } : {}),
      ...(unreadOnly ? { unread: unreadKeys(runtime, account) } : {}),
    })
    return { ...page, items: page.items.map((item) => localSummary(runtime, account, item)) }
  })

  router.get('/messages/lookup', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = url.searchParams.get('key') ?? ''
    if (key.startsWith('local:')) {
      const id = Number(key.slice(6))
      const detail = runtime.database(account).get(id)
      if (detail === undefined) throw new HttpError(404, '邮件不存在')
      return { id: String(id), mailbox: detail.mailbox, subject: detail.subject }
    }
    if (key.startsWith('mid:')) {
      const found = runtime.database(account).findByMessageId(key.slice(4))
      if (found === undefined) throw new HttpError(404, '本地备份里找不到这封邮件')
      return { id: String(found.id), mailbox: found.mailbox, subject: '' }
    }
    throw new HttpError(400, '无法定位这封邮件')
  })

  router.post('/messages/:id/star', async ({ url, params, body }) => {
    const payload = await body()
    const { account } = accountFrom(runtime, url)
    const detail = await loadDetail(
      runtime,
      account,
      sourceOfPayload(payload),
      String(params.id ?? ''),
      mailboxOfPayload(payload),
    )
    const starred = payload.starred !== false
    const key = messageKeyOf(detail)
    runtime.flags(account).set(key, starred)
    if (detail.uid !== undefined) {
      try {
        await runtime.provider(account).setFlag(detail.mailbox, detail.uid, '\\Flagged', starred)
      } catch {
        // Local-first: the star still shows even when the server is offline.
      }
    }
    return { starred }
  })

  router.post('/messages/:id/move', async ({ url, params, body }) => {
    const payload = await body()
    const { account } = accountFrom(runtime, url)
    const target = String(payload.target ?? '').trim()
    if (target === '') throw new HttpError(400, '缺少目标文件夹')
    const detail = runtime.database(account).get(Number(params.id))
    if (detail === undefined) throw new HttpError(404, '邮件不存在')
    if (detail.uid !== undefined) {
      try {
        await runtime.provider(account).move(detail.mailbox, detail.uid, target)
      } catch {
        // Keep the local move: archived mail may no longer exist on the server.
      }
    }
    moveLocalMessage(runtime.paths(account).mailDb, Number(params.id), target)
    return { ok: true, mailbox: target }
  })

  router.post('/messages/bulk', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const action = String(payload.action ?? '')
    const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => Number(id)) : []
    if (ids.length === 0) return { ok: true, count: 0 }
    const database = runtime.database(account)
    const flags = runtime.flags(account)
    const readState = runtime.readState(account)
    let count = 0
    for (const id of ids) {
      const detail = database.get(id)
      if (detail === undefined) continue
      const key = messageKeyOf(detail)
      if (action === 'read' || action === 'unread') {
        readState.setUnread(key, action === 'unread')
        if (detail.uid !== undefined) {
          try {
            await runtime.provider(account).setSeen(detail.mailbox, detail.uid, action === 'read')
          } catch {
            // Keep the local state.
          }
        }
        count += 1
      } else if (action === 'archive' || action === 'delete' || action === 'move') {
        const target = String(payload.target ?? '').trim()
        if (target === '') continue
        if (detail.uid !== undefined) {
          try {
            await runtime.provider(account).move(detail.mailbox, detail.uid, target)
          } catch {
            // Archived mail may no longer exist on the server.
          }
        }
        moveLocalMessage(runtime.paths(account).mailDb, Number(detail.id), target)
        count += 1
      } else if (action === 'star' || action === 'unstar') {
        const starred = action === 'star'
        flags.set(key, starred)
        if (detail.uid !== undefined) {
          try {
            await runtime.provider(account).setFlag(detail.mailbox, detail.uid, '\\Flagged', starred)
          } catch {
            // Local only.
          }
        }
        count += 1
      }
    }
    return { ok: true, count }
  })

  router.post('/maintenance/optimize', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    return optimizeDatabase(runtime.paths(account).mailDb)
  })

  router.get('/maintenance/references', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    return runtime.referencesStatus(account)
  })

  router.post('/maintenance/references', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    runtime.startReferencesBackfill(account)
    return runtime.referencesStatus(account)
  })

  router.get('/transfer/export', () => {
    const config = runtime.current
    return {
      format: 'mailharbor-transfer',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        signature: config.signature,
        read: config.read,
        render: config.render,
        ai: {
          enabled: config.ai.enabled,
          provider: config.ai.provider,
          model: config.ai.model,
          summaryLength: config.ai.summaryLength,
        },
      },
      accounts: config.accounts.map((account) => ({
        email: account.email,
        label: account.label,
        username: account.username,
        imap: account.imap,
        smtp: account.smtp,
        auth: account.auth,
        enabled: account.enabled,
      })),
    }
  })

  router.post('/transfer/import', async ({ body }) => {
    const payload = await body()
    if (payload.format !== 'mailharbor-transfer' || !Array.isArray(payload.accounts)) {
      throw new HttpError(400, '不是有效的 MailHarbor 配置文件')
    }
    const config = runtime.current
    const accounts = [...config.accounts]
    let added = 0
    for (const raw of payload.accounts as Record<string, unknown>[]) {
      const email = String(raw.email ?? '').trim()
      if (email === '' || accounts.some((account) => account.email.toLowerCase() === email.toLowerCase()))
        continue
      try {
        const account = normalizeAccount(
          {
            email,
            label: typeof raw.label === 'string' ? raw.label : undefined,
            username: typeof raw.username === 'string' ? raw.username : undefined,
            imap: asObject(raw.imap) as unknown as Account['imap'],
            smtp: asObject(raw.smtp) as unknown as Account['smtp'],
            ...(raw.auth !== undefined ? { auth: raw.auth as Account['auth'] } : {}),
          },
          accounts.length,
          accounts.map((account) => account.id),
        )
        accounts.push(account)
        added += 1
      } catch {
        // Skip malformed entries; the rest still imports.
      }
    }
    if (added > 0) saveAccounts(accounts, config.activeAccountId ?? accounts[0]?.id ?? null)
    const settings = asObject(payload.settings)
    const patch: Record<string, unknown> = {}
    if (typeof settings.signature === 'string') patch.signature = settings.signature.slice(0, 5000)
    const read = asObject(settings.read)
    if (typeof read.markOnOpen === 'boolean') patch.read = { markOnOpen: read.markOnOpen }
    const render = asObject(settings.render)
    if (typeof render.listLimit === 'number') patch.render = { listLimit: render.listLimit }
    const ai = asObject(settings.ai)
    if (ai.summaryLength !== undefined) patch.ai = { summaryLength: ai.summaryLength }
    if (Object.keys(patch).length > 0) saveSettings(patch)
    runtime.refresh()
    return { ok: true, addedAccounts: added, state: appState(runtime) }
  })

  router.get('/messages/thread', async ({ url }) => {
    const { account } = accountFrom(runtime, url)
    const subject = url.searchParams.get('subject') ?? ''
    const messageId = url.searchParams.get('messageId') ?? ''
    const items = await runtime.database(account).thread({ subject, messageId })
    return { items: items.map((item) => localSummary(runtime, account, item)) }
  })

  router.get('/contacts', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    const query = url.searchParams.get('q') ?? ''
    return { items: runtime.database(account).contacts(query, 50) }
  })

  router.get('/messages/:id', async ({ url, params }) => {
    const { account } = accountFrom(runtime, url)
    const source = sourceOf(url)
    const mailbox = url.searchParams.get('mailbox') ?? 'INBOX'
    return loadDetail(runtime, account, source, params.id ?? '', mailbox)
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
      writeAttachment(
        res,
        file.filename,
        file.contentType,
        Buffer.from(file.dataBase64, 'base64'),
        canPreviewInline(file.contentType) && url.searchParams.get('inline') === '1',
      )
      return undefined
    }
    const emailId = Number(url.searchParams.get('emailId') ?? 0)
    const attachmentId = Number(url.searchParams.get('attachmentId') ?? 0)
    const file = runtime.database(account).attachment(emailId, attachmentId)
    if (file === undefined) throw new HttpError(404, '附件不存在')
    writeAttachment(
      res,
      file.filename,
      file.contentType,
      Buffer.from(file.data),
      canPreviewInline(file.contentType) && url.searchParams.get('inline') === '1',
    )
    return undefined
  })

  router.get('/drafts', ({ url }) => {
    const { account } = accountFrom(runtime, url)
    return { items: runtime.drafts(account).list() }
  })

  router.post('/drafts', async ({ url, body }) => {
    const { account } = accountFrom(runtime, url)
    const payload = await body()
    const store = runtime.drafts(account)
    const draft = store.save(normalizeDraftInput(payload, account.id))
    if (payload.remote !== true) return { draft }
    if (!runtime.hasCredentials(account)) return { draft, syncError: '未登录，草稿仅保存在本地' }
    try {
      const raw = await draftMime(account, draft)
      const provider = runtime.provider(account)
      const appended = await provider.appendDraft(raw)
      if (draft.remoteUid !== undefined && draft.remoteMailbox !== undefined) {
        try {
          await provider.deleteMessage(draft.remoteMailbox, draft.remoteUid)
        } catch {
          // The old copy may already be gone; the new one is what matters.
        }
      }
      const updated = store.save({ ...draft, remoteUid: appended.uid, remoteMailbox: appended.mailbox })
      return { draft: updated }
    } catch (error) {
      return {
        draft,
        syncError: error instanceof Error ? error.message : String(error),
      }
    }
  })

  router.delete('/drafts/:id', async ({ url, params }) => {
    const { account } = accountFrom(runtime, url)
    const draft = runtime.drafts(account).get(params.id ?? '')
    const removed = runtime.drafts(account).remove(params.id ?? '')
    if (!removed) throw new HttpError(404, '草稿不存在')
    if (
      draft?.remoteUid !== undefined &&
      draft.remoteMailbox !== undefined &&
      runtime.hasCredentials(account)
    ) {
      try {
        await runtime.provider(account).deleteMessage(draft.remoteMailbox, draft.remoteUid)
      } catch {
        // Best effort: the local draft is already gone.
      }
    }
    return { ok: true }
  })

  router.post('/send', async ({ url, body }) => {
    const { account } = accountFrom(runtime, url)
    const payload = await body()
    const result = await sendFromPayload(runtime, account, payload)
    return result
  })

  router.get('/unread', async ({ url }) => {
    const requested = url.searchParams.get('accountId')
    const accounts =
      requested === null || requested === '' || requested === 'all'
        ? runtime.current.accounts.filter((item) => item.enabled !== false)
        : [accountById(runtime, requested)]
    // The panel shows the local backup, so its badge must count the same
    // unread keys the list renders (kept in sync from IMAP flags).
    const local = accounts.reduce((sum, account) => {
      try {
        return sum + runtime.database(account).countUnread(unreadKeys(runtime, account))
      } catch {
        return sum
      }
    }, 0)
    return { unread: local, source: 'local' }
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
      signature:
        typeof payload.signature === 'string' ? payload.signature.slice(0, 5000) : existing.signature,
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

  router.get('/ai/thread', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (key === '') throw new HttpError(400, '缺少线程 key')
    return { thread: runtime.aiThreads(account).get(key) }
  })

  router.delete('/ai/thread', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (key === '') throw new HttpError(400, '缺少线程 key')
    return { ok: runtime.aiThreads(account).clear(key) }
  })

  router.delete('/ai/cards', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = (url.searchParams.get('key') ?? '').trim()
    const cardId = (url.searchParams.get('cardId') ?? '').trim()
    if (key === '' || cardId === '') throw new HttpError(400, '缺少线程 key 或卡片 id')
    return { thread: runtime.aiThreads(account).removeCard(key, cardId) }
  })

  router.post('/ai/cards', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const key = String(payload.key ?? '').trim()
    if (key === '' || key.length > 200) throw new HttpError(400, '缺少线程 key')
    const kind = String(payload.kind ?? '')
    if (!['summary', 'reply', 'translate', 'answer'].includes(kind)) {
      throw new HttpError(400, `未知的卡片类型: ${kind}`)
    }
    const detail = await loadDetail(
      runtime,
      account,
      sourceOfPayload(payload),
      String(payload.id ?? ''),
      mailboxOfPayload(payload),
    )
    const config = runtime.current
    const summaryLength =
      payload.length === 'normal' || payload.length === 'detailed' || payload.length === 'brief'
        ? payload.length
        : config.ai.summaryLength
    const instruction = typeof payload.instruction === 'string' ? payload.instruction : ''
    const language = payload.language === 'en' ? 'en' : 'zh'
    const target = payload.target === 'en' ? 'en' : 'zh'
    const ai = runtime.ai()
    try {
      let output = ''
      let html: string | undefined
      let meta: Record<string, string> | undefined
      if (kind === 'summary') {
        output = await ai.summarize(detail, account.email, summaryLength)
        meta = { length: summaryLength }
      } else if (kind === 'reply') {
        output = await ai.reply(account, detail, { instruction, language })
        html = textToHtml(output)
        meta = {
          to: detail.from.address,
          subject: /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`,
          inReplyTo: detail.messageId ?? '',
          references: [detail.references.join(' '), detail.messageId ?? ''].join(' ').trim(),
          language,
        }
      } else if (kind === 'translate') {
        const source = detail.html !== null && detail.html !== '' ? detail.html : detail.text
        const translated = normalizeTranslated(await ai.translate(source, target))
        output = translated.text
        html = translated.html
        meta = { target }
      } else {
        const earlier =
          runtime
            .aiThreads(account)
            .get(key)
            ?.cards.filter((card) => card.kind === 'answer')
            .map((card) => card.output) ?? []
        output = await ai.ask(detail, instruction, earlier, account.email)
      }
      const card = {
        id: randomUUID(),
        kind: kind as 'summary' | 'reply' | 'translate' | 'answer',
        instruction,
        output,
        ...(html === undefined ? {} : { html }),
        ...(meta === undefined ? {} : { meta }),
        provider: config.ai.provider,
        model: config.ai.model,
        createdAt: new Date().toISOString(),
      }
      const thread = runtime.aiThreads(account).appendCard({
        key,
        accountId: account.id,
        subject: detail.subject,
        messageId: detail.messageId ?? '',
        card,
      })
      return { card, thread }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.post('/ai/search', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const query = String(payload.query ?? '').trim()
    if (query === '') throw new HttpError(400, '搜索内容不能为空')
    const source = sourceOfPayload(payload)
    const mailbox = String(payload.mailbox ?? 'all')
    try {
      const filters = await runtime.ai().parseSearch(query)
      const hasCondition =
        filters.keywords.length > 0 ||
        filters.from !== '' ||
        filters.subject !== '' ||
        filters.since !== '' ||
        filters.before !== ''
      if (!hasCondition) throw new HttpError(400, '没有理解出可用的搜索条件，请换个说法')
      if (source === 'server') {
        const provider = runtime.provider(account)
        const result = await provider.search(mailbox === 'all' ? 'INBOX' : mailbox, {
          ...filters,
          limit: 60,
        })
        return {
          items: result.items.map((item) => ({ ...item, accountId: account.id })),
          total: result.total,
          offset: 0,
          limit: 60,
          ai: filters,
        }
      }
      const database = runtime.database(account)
      // Local search is cross-folder: a search should find a mail wherever it is.
      const keywords = [...filters.keywords]
      let page = database.searchAdvanced({ ...filters, subject: '', keywords, mailbox: 'all', limit: 60 })
      if (page.total === 0 && filters.subject !== '') {
        page = database.searchAdvanced({
          ...filters,
          subject: '',
          keywords: [...keywords, filters.subject],
          mailbox: 'all',
          limit: 60,
        })
      }
      return {
        ...page,
        items: page.items.map((item) => ({ ...item, accountId: account.id })),
        ai: filters,
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw aiHttpError(error)
    }
  })

  router.post('/ai/compose', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const mode = payload.mode === 'polish' ? 'polish' : payload.mode === 'shorten' ? 'shorten' : 'draft'
    const html = typeof payload.html === 'string' ? payload.html : ''
    const instruction = typeof payload.instruction === 'string' ? payload.instruction : ''
    const language = payload.language === 'en' ? 'en' : 'zh'
    try {
      const text = await runtime.ai().compose(account, { mode, instruction, html, language })
      return { text, html: /<[a-z][\s\S]*>/i.test(text) ? text : textToHtml(text) }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.get('/ai/status', ({ url }) => {
    const requested = url.searchParams.get('accountId')
    const account =
      requested !== null && requested !== '' && requested !== 'all'
        ? runtime.current.accounts.find((item) => item.id === requested)
        : runtime.active()
    return runtime.ai().status(account ?? null)
  })

  router.get('/ai/models', async () => ({ providers: await runtime.ai().models() }))

  router.post('/ai/summary', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const detail = await loadDetail(
      runtime,
      account,
      sourceOfPayload(payload),
      String(payload.id ?? ''),
      mailboxOfPayload(payload),
    )
    try {
      const length =
        payload.length === 'normal' || payload.length === 'detailed' || payload.length === 'brief'
          ? payload.length
          : runtime.current.ai.summaryLength
      const summary = await runtime.ai().summarize(detail, account.email, length)
      return { summary, blocks: summaryBlocks(summary), length }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.post('/ai/reply', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const detail = await loadDetail(
      runtime,
      account,
      sourceOfPayload(payload),
      String(payload.id ?? ''),
      mailboxOfPayload(payload),
    )
    const language = payload.language === 'en' ? 'en' : 'zh'
    const instruction = typeof payload.instruction === 'string' ? payload.instruction : ''
    try {
      const text = await runtime.ai().reply(account, detail, { instruction, language })
      return { text, html: textToHtml(text) }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.post('/ai/translate', async ({ body }) => {
    const payload = await body()
    const html = typeof payload.html === 'string' ? payload.html : ''
    const target = payload.target === 'en' ? 'en' : 'zh'
    try {
      const translated = normalizeTranslated(await runtime.ai().translate(html, target))
      return { text: translated.text, html: translated.html }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.get('/ai/style', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    return { style: runtime.ai().style(account) }
  })

  router.put('/ai/style', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    try {
      const style = runtime.ai().saveStyle(account, String(payload.profile ?? ''))
      return { style }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  router.post('/ai/style/learn', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    try {
      const samples = runtime.database(account).sentMessages(100)
      const style = await runtime.ai().learnStyle(account, samples)
      return { style }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  // ---- tasks ----

  router.get('/tasks', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const items = runtime.tasks().list({
      accountId: account.id,
      status: url.searchParams.get('status') ?? '',
      projectId: url.searchParams.get('projectId') ?? '',
      query: url.searchParams.get('query') ?? '',
    })
    return { items: items.map(taskView) }
  })

  router.post('/tasks', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const task = runtime.tasks().create({
      accountId: account.id,
      title: String(payload.title ?? ''),
      notes: typeof payload.notes === 'string' ? payload.notes : '',
      due: typeof payload.due === 'string' ? payload.due : '',
      status: typeof payload.status === 'string' ? payload.status : 'NEEDS-ACTION',
      priority: Number(payload.priority ?? 0),
      owner: typeof payload.owner === 'string' ? payload.owner : '',
      projectId: typeof payload.projectId === 'string' ? payload.projectId : null,
      messageKey: typeof payload.messageKey === 'string' ? payload.messageKey : '',
      messageSubject: typeof payload.messageSubject === 'string' ? payload.messageSubject : '',
    })
    return { task: taskView(task) }
  })

  router.patch('/tasks/:id', async ({ params, body }) => {
    const payload = await body()
    const task = runtime.tasks().update(String(params.id ?? ''), {
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(typeof payload.notes === 'string' ? { notes: payload.notes } : {}),
      ...(typeof payload.due === 'string' ? { due: payload.due } : {}),
      ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
      ...(typeof payload.priority === 'number' ? { priority: payload.priority } : {}),
      ...(typeof payload.owner === 'string' ? { owner: payload.owner } : {}),
      ...(payload.projectId === null || typeof payload.projectId === 'string'
        ? { projectId: payload.projectId }
        : {}),
    })
    return { task: taskView(task) }
  })

  router.delete('/tasks/:id', ({ params }) => {
    const removed = runtime.tasks().remove(String(params.id ?? ''))
    if (!removed) throw new HttpError(404, '任务不存在')
    return { ok: true }
  })

  router.post('/tasks/extract', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const detail = await loadDetail(
      runtime,
      account,
      sourceOfPayload(payload),
      String(payload.id ?? ''),
      mailboxOfPayload(payload),
    )
    try {
      const suggestions = await runtime.ai().extractTasks(detail)
      return { suggestions }
    } catch (error) {
      throw aiHttpError(error)
    }
  })

  // ---- projects ----

  router.get('/projects', () => ({ items: runtime.projects().list().map(projectView) }))

  router.get('/projects/for', ({ url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = url.searchParams.get('key') ?? ''
    return {
      project:
        key === ''
          ? null
          : (() => {
              const found = runtime.projects().findByMessage(account.id, key)
              return found === undefined ? null : projectView(found)
            })(),
    }
  })

  router.post('/projects/pick-directory', async () => {
    const path = await pickDirectory()
    return { path }
  })

  router.post('/projects', async ({ body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const name = String(payload.name ?? '').trim()
    const root = String(payload.root ?? '').trim() || runtime.current.projects.root
    const conversation = typeof payload.conversation === 'string' ? payload.conversation : ''
    const message = asObject(payload.message)
    const key = typeof message.key === 'string' ? message.key : ''
    const result = await createProject({
      store: runtime.projects(),
      input: {
        name,
        root,
        conversation,
        accountId: account.id,
        ...(key === ''
          ? {}
          : {
              message: {
                accountId: account.id,
                key,
                subject: String(message.subject ?? ''),
                date: String(message.date ?? ''),
              },
            }),
        ...(key === '' ? {} : { thread: { accountId: account.id, key } }),
      },
      registry: runtime.workspaceRegistry,
      sessions: runtime.sessions,
    })
    return { project: projectView(result.project), warnings: result.warnings }
  })

  router.patch('/projects/:id', async ({ params, body }) => {
    const payload = await body()
    const name = String(payload.name ?? '').trim()
    if (name === '') throw new HttpError(400, '项目名称不能为空')
    const project = runtime.projects().update(String(params.id ?? ''), { name })
    if (project === undefined) throw new HttpError(404, '项目不存在')
    return { project: projectView(project) }
  })

  router.delete('/projects/:id', async ({ params, url }) => {
    const id = String(params.id ?? '')
    const project = runtime.projects().get(id)
    if (project === undefined) throw new HttpError(404, '项目不存在')
    const warnings: string[] = []
    const removed = runtime.projects().remove(id)
    const unlinked = runtime.tasks().clearProject(id)

    let workspaceRemoved = false
    if (project.workspaceId !== '' && runtime.workspaceRegistry?.delete !== undefined) {
      try {
        workspaceRemoved = await runtime.workspaceRegistry.delete(project.workspaceId)
      } catch (error) {
        warnings.push(`移除工作空间失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (project.workspaceId !== '') {
      warnings.push('当前 DSH 组合不支持自动移除工作空间，请在侧栏手动删除')
    }

    let filesRemoved = false
    if (url.searchParams.get('files') === '1') {
      try {
        const root = runtime.current.projects.root
        const insideRoot = project.path === root || project.path.startsWith(`${root}/`)
        const marker = existsSync(`${project.path}/project.json`)
        if (!insideRoot && !marker) {
          warnings.push('项目目录不在默认项目根目录下，出于安全考虑未删除文件')
        } else if (project.path === root || project.path === '/') {
          warnings.push('拒绝删除项目根目录')
        } else {
          rmSync(project.path, { recursive: true, force: true })
          filesRemoved = true
        }
      } catch (error) {
        warnings.push(`删除文件夹失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      ok: removed,
      path: project.path,
      unlinkedTasks: unlinked,
      workspaceRemoved,
      filesRemoved,
      warnings,
    }
  })

  router.post('/projects/:id/open', async ({ params }) => {
    const project = runtime.projects().get(String(params.id ?? ''))
    if (project === undefined) throw new HttpError(404, '项目不存在')
    try {
      await openPath(project.path)
      return { path: project.path }
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error))
    }
  })

  router.post('/projects/:id/messages', async ({ params, body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const project = runtime.projects().addMessage(String(params.id ?? ''), {
      accountId: account.id,
      key: String(payload.key ?? ''),
      subject: String(payload.subject ?? ''),
      date: String(payload.date ?? ''),
    })
    if (project === undefined) throw new HttpError(404, '项目不存在')
    return { project: projectView(project) }
  })

  router.delete('/projects/:id/messages', ({ params, url }) => {
    const account = accountFromPayload(runtime, { accountId: url.searchParams.get('accountId') ?? undefined })
    const key = url.searchParams.get('key') ?? ''
    const project = runtime.projects().removeMessage(String(params.id ?? ''), account.id, key)
    if (project === undefined) throw new HttpError(404, '项目不存在')
    return { project: projectView(project) }
  })

  router.post('/projects/:id/transfer', async ({ params, body }) => {
    const payload = await body()
    const account = accountFromPayload(runtime, payload)
    const project = runtime.projects().get(String(params.id ?? ''))
    if (project === undefined) throw new HttpError(404, '项目不存在')
    const conversation = typeof payload.conversation === 'string' ? payload.conversation : ''
    if (conversation.trim() === '') throw new HttpError(400, '没有可转移的 AI 记录')
    appendConversation(project, conversation)
    const key = typeof payload.key === 'string' ? payload.key : ''
    const updated =
      key === ''
        ? runtime.projects().update(project.id, {})
        : runtime.projects().addThread(project.id, { accountId: account.id, key })
    return { project: projectView(updated ?? project) }
  })

  router.get('/settings', () => settingsView(runtime.current))

  router.patch('/settings', async ({ body }) => {
    const payload = await body()
    const patch: Record<string, unknown> = {}
    if (typeof payload.signature === 'string') patch.signature = payload.signature.slice(0, 5000)
    if (payload.ai !== undefined) patch.ai = asObject(payload.ai)
    if (payload.read !== undefined) patch.read = asObject(payload.read)
    if (payload.render !== undefined) patch.render = asObject(payload.render)
    if (payload.projects !== undefined) {
      const root = String(asObject(payload.projects).root ?? '').trim()
      if (root === '') throw new HttpError(400, '项目目录不能为空')
      patch.projects = { root: resolveUserPath(root, '项目目录') }
    }
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

/** Load one message from either source; shared by the mail and AI routes. */
async function loadDetail(
  runtime: MailHarborRuntime,
  account: Account,
  source: 'local' | 'server',
  id: string,
  mailbox: string,
): Promise<MessageDetail> {
  if (source === 'server') {
    const message = await runtime.provider(account).read(mailbox, Number(id))
    return serverDetail(runtime, account, message, mailbox)
  }
  const detail = runtime.database(account).get(Number(id))
  if (detail === undefined) throw new HttpError(404, '邮件不存在')
  return localDetail(runtime, account, detail)
}

/** Merge the local backup of every enabled account into one newest-first page. */
function listAllAccounts(
  runtime: MailHarborRuntime,
  options: { mailbox: string; query: string; offset: number; limit: number },
): Page<MessageSummary> {
  const accounts = runtime.current.accounts.filter((item) => item.enabled !== false)
  const collected: MessageSummary[] = []
  let total = 0
  for (const account of accounts) {
    try {
      const page = runtime.database(account).list({
        mailbox: options.mailbox === '' ? 'all' : options.mailbox,
        query: options.query,
        offset: 0,
        limit: options.offset + options.limit,
      })
      total += page.total
      for (const item of page.items) collected.push(localSummary(runtime, account, item))
    } catch {
      // An account without a backup contributes nothing.
    }
  }
  collected.sort((left, right) => right.date.localeCompare(left.date))
  return {
    items: collected.slice(options.offset, options.offset + options.limit),
    total,
    offset: options.offset,
    limit: options.limit,
  }
}

function accountFromPayload(runtime: MailHarborRuntime, payload: Record<string, unknown>): Account {
  const requested = typeof payload.accountId === 'string' ? payload.accountId : ''
  if (requested !== '' && requested !== 'all') {
    const found = runtime.current.accounts.find((item) => item.id === requested)
    if (found !== undefined) return found
  }
  const active = runtime.active()
  if (active !== null) return active
  throw new HttpError(400, '请先添加一个邮箱账号')
}

function sourceOfPayload(payload: Record<string, unknown>): 'local' | 'server' {
  return payload.source === 'server' ? 'server' : 'local'
}

function mailboxOfPayload(payload: Record<string, unknown>): string {
  return typeof payload.mailbox === 'string' && payload.mailbox !== '' ? payload.mailbox : 'INBOX'
}

function aiHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  return new HttpError(400, error instanceof Error ? error.message : String(error))
}

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
      summaryLength: config.ai.summaryLength,
    },
    read: { markOnOpen: config.read.markOnOpen, pollSeconds: config.read.pollSeconds },
    render: { listLimit: config.render.listLimit },
    projects: { root: config.projects.root },
  }
}

function taskView(task: TaskRecord): Task {
  return {
    id: task.id,
    accountId: task.accountId,
    projectId: task.projectId,
    title: task.title,
    notes: task.notes,
    due: task.due,
    status: task.status as Task['status'],
    priority: task.priority,
    owner: task.owner,
    messageKey: task.messageKey,
    messageSubject: task.messageSubject,
    dirty: task.dirty,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  }
}

function projectView(project: ProjectRecord): Project {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    workspaceId: project.workspaceId,
    sessionId: project.sessionId,
    accountIds: [...project.accountIds],
    messages: project.messages.map((message) => ({ ...message })),
    threads: project.threads.map((thread) => ({ ...thread })),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function unreadKeys(runtime: MailHarborRuntime, account: Account): { mids: string[]; ids: number[] } {
  const mids: string[] = []
  const ids: number[] = []
  for (const key of runtime.readState(account).list()) {
    if (key.startsWith('mid:')) mids.push(key.slice(4))
    else if (key.startsWith('local:')) {
      const id = Number(key.slice(6))
      if (Number.isFinite(id)) ids.push(id)
    }
  }
  return { mids, ids }
}

function messageKeyOf(row: { messageId?: string; id: string }): string {
  return row.messageId !== undefined && row.messageId !== '' ? `mid:${row.messageId}` : `local:${row.id}`
}

function localSummary(runtime: MailHarborRuntime, account: Account, row: MessageSummary): MessageSummary {
  const store = runtime.readState(account)
  const key = messageKeyOf(row)
  return {
    ...row,
    accountId: account.id,
    unread: store.isUnread(key),
    starred: runtime.flags(account).has(key),
    backedUp: true,
  }
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
  offset = 0,
): Promise<Omit<Page<MessageSummary>, 'offset' | 'limit'>> {
  const provider = runtime.provider(account)
  const result = await provider.list(mailbox === 'all' ? 'INBOX' : mailbox, Math.min(200, limit * 2), offset)
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

function canPreviewInline(contentType: string): boolean {
  const type = contentType.toLowerCase()
  return (
    (type.startsWith('image/') && type !== 'image/svg+xml') ||
    type === 'application/pdf' ||
    type === 'text/plain' ||
    type === 'text/csv' ||
    type === 'text/markdown' ||
    type === 'application/json'
  )
}

function writeAttachment(
  res: ServerResponse,
  filename: string,
  contentType: string,
  data: Buffer,
  inline = false,
): void {
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', String(data.length))
  res.setHeader(
    'content-disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
  // Attachments are immutable content; let the browser cache previews.
  res.setHeader('cache-control', 'private, max-age=86400')
  res.setHeader('x-content-type-options', 'nosniff')
  // Attachment payloads are untrusted; a sandbox CSP stops scripts even if a
  // file is opened directly in the browser.
  res.setHeader(
    'content-security-policy',
    "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  )
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
  const signature =
    (account.signature ?? '').trim() !== '' ? String(account.signature).trim() : runtime.current.signature
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
