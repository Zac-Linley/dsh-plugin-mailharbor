import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isTrustedRequest, Router } from '../src/host/http.js'
import type { MailHarborRuntime } from '../src/host/runtime.js'

const dir = mkdtempSync(join(tmpdir(), 'mailharbor-api-'))
process.env.DSH_MAILHARBOR_DATA_DIR = dir

let server: Server
let base = ''
let runtime: MailHarborRuntime
let accountId = ''

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init)
}

beforeAll(async () => {
  const { normalizeAccount } = await import('../src/host/config.js')
  const { saveAccounts } = await import('../src/host/config.js')
  const { ensureMailSchema } = await import('../src/host/mail-db.js')
  const { MailHarborRuntime } = await import('../src/host/runtime.js')
  const { createApiHandler } = await import('../src/host/api.js')

  const account = normalizeAccount({
    email: 'me@example.com',
    label: 'Test',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true, fromName: '' },
  })
  accountId = account.id
  const second = normalizeAccount({
    email: 'other@example.com',
    label: 'Second',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true, fromName: '' },
  })
  saveAccounts([account, second], account.id)

  // A second mailbox so the unified inbox has something to merge.
  const secondDir = join(dir, 'accounts', second.id)
  mkdirSync(secondDir, { recursive: true })
  ensureMailSchema(join(secondDir, 'mail.db'))
  const secondDb = new DatabaseSync(join(secondDir, 'mail.db'))
  secondDb
    .prepare(
      `INSERT INTO emails (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id, body_text, body_html)
     VALUES ('Sent Items', 3, 'Re: Hello there', 'Me', 'me@example.com', 'alice@example.com', '', '2026-11-02 10:00:00', 'm2@example.com', 'Sent body', '')`,
    )
    .run()
  secondDb.close()

  const accountDir = join(dir, 'accounts', account.id)
  mkdirSync(join(accountDir, 'attachments', 'ab', 'cd'), { recursive: true })
  writeFileSync(join(accountDir, 'attachments', 'ab', 'cd', 'abcd1234'), Buffer.from('attachment-bytes'))
  const dbFile = join(accountDir, 'mail.db')
  ensureMailSchema(dbFile)
  const db = new DatabaseSync(dbFile)
  db.prepare(
    `INSERT INTO emails (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id, body_text, body_html)
     VALUES ('INBOX', 7, 'Hello there', 'Alice', 'alice@example.com', 'me@example.com', '', '2026-11-01 09:00:00', 'm1@example.com', 'Body text', '<p>Body <b>html</b></p>')`,
  ).run()
  db.prepare(
    "INSERT INTO attachments (email_id, filename, content_type, size, hash) VALUES (1, 'notes.txt', 'text/plain', 16, 'abcd1234')",
  ).run()
  db.close()

  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '结论\n需要复核预算。\n\n需要你做什么\n- 周五前确认' }
      yield { type: 'finish', reason: { kind: 'ok' } }
    },
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }],
  }
  runtime = new MailHarborRuntime({ llm: () => fakeLlm as never })
  runtime.credentials.remember(account, 'secret', false)
  const handler = createApiHandler(runtime)
  server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('mail API', () => {
  it('reports state with the configured account', async () => {
    const response = await request('/mail-plugin/api/state')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      activeAccountId: string
      loggedIn: boolean
      accounts: { email: string }[]
      settings: { dataDir: string }
    }
    expect(body.activeAccountId).toBe(accountId)
    expect(body.loggedIn).toBe(true)
    expect(body.accounts[0]?.email).toBe('me@example.com')
    expect(body.settings.dataDir).toBe(dir)
  })

  it('lists folders and messages from the local backup', async () => {
    const folders = (await (await request('/mail-plugin/api/folders?source=local')).json()) as {
      items: { name: string; count: number }[]
    }
    expect(folders.items).toEqual([
      { name: '__drafts', count: 0 },
      { name: 'INBOX', count: 1 },
    ])
    const all = (await (await request('/mail-plugin/api/folders?source=local&accountId=all')).json()) as {
      items: { name: string; count: number }[]
    }
    expect(all.items).toEqual([
      { name: '__drafts', count: 0 },
      { name: 'INBOX', count: 1 },
      { name: 'Sent Items', count: 1 },
    ])

    const page = (await (await request('/mail-plugin/api/messages?source=local&mailbox=INBOX')).json()) as {
      total: number
      items: { id: string; subject: string; unread: boolean; hasAttachments: boolean }[]
    }
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ subject: 'Hello there', unread: false, hasAttachments: true })
  })

  it('reads one message and its attachment bytes', async () => {
    const detail = (await (await request('/mail-plugin/api/messages/1?source=local')).json()) as {
      subject: string
      text: string
      html: string
      attachments: { id: string }[]
    }
    expect(detail.subject).toBe('Hello there')
    expect(detail.text).toBe('Body text')
    expect(detail.html).toContain('<b>html</b>')
    expect(detail.attachments).toHaveLength(1)

    const attachment = await request('/mail-plugin/api/attachment?source=local&emailId=1&attachmentId=1')
    expect(attachment.status).toBe(200)
    expect(attachment.headers.get('content-disposition')).toContain('notes.txt')
    expect(await attachment.text()).toBe('attachment-bytes')
  })

  it('marks a local message unread and reports it in the list', async () => {
    const response = await request('/mail-plugin/api/messages/1/read?source=local', {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ read: false }),
    })
    expect(response.status).toBe(200)
    const page = (await (await request('/mail-plugin/api/messages?source=local')).json()) as {
      items: { unread: boolean }[]
    }
    expect(page.items[0]?.unread).toBe(true)

    await request('/mail-plugin/api/messages/1/read?source=local', {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ read: true }),
    })
  })

  it('rejects a send without recipients', async () => {
    const response = await request('/mail-plugin/api/send', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'Hi', html: '<p>x</p>' }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('收件人')
  })

  it('rejects cross-site writes', async () => {
    const response = await request('/mail-plugin/api/messages/1/read?source=local', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ read: false }),
    })
    expect(response.status).toBe(403)
  })

  it('returns 404 for an unknown route', async () => {
    const response = await request('/mail-plugin/api/nope')
    expect(response.status).toBe(404)
  })

  it('merges every account into the unified inbox', async () => {
    const page = (await (
      await request('/mail-plugin/api/messages?accountId=all&source=local&mailbox=all')
    ).json()) as {
      total: number
      items: { subject: string; accountId: string }[]
    }
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.subject).sort()).toEqual(['Hello there', 'Re: Hello there'])
    expect(new Set(page.items.map((item) => item.accountId)).size).toBe(2)
    expect(await (await request('/mail-plugin/api/messages?accountId=all&source=server')).status).toBe(400)
  })

  it('exposes AI status, summary and translation', async () => {
    const status = (await (await request('/mail-plugin/api/ai/status')).json()) as {
      available: boolean
      enabled: boolean
    }
    expect(status.available).toBe(true)
    expect(status.enabled).toBe(true)

    const summary = (await (
      await request('/mail-plugin/api/ai/summary', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, source: 'local', id: '1', mailbox: 'INBOX' }),
      })
    ).json()) as { summary: string; blocks: { title: string; body: string }[] }
    expect(summary.summary).toContain('需要复核')
    expect(summary.blocks[0]?.title).toBe('结论')

    const translated = (await (
      await request('/mail-plugin/api/ai/translate', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, html: '<p>你好</p>', target: 'en' }),
      })
    ).json()) as { html: string }
    expect(translated.html).toContain('<p>')
  })

  it('persists AI cards in a per-mail thread', async () => {
    const key = 'mid:m1@example.com'
    const send = (payload: Record<string, unknown>): Promise<Response> =>
      request('/mail-plugin/api/ai/cards', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, key, source: 'local', id: '1', mailbox: 'INBOX', ...payload }),
      })

    const summary = (await (await send({ kind: 'summary' })).json()) as {
      card: { id: string; kind: string; output: string }
      thread: { cards: unknown[] }
    }
    expect(summary.card.kind).toBe('summary')
    expect(summary.thread.cards).toHaveLength(1)

    const reply = (await (await send({ kind: 'reply', instruction: '确认收到' })).json()) as {
      card: { meta: { to: string; subject: string }; html: string }
      thread: { cards: unknown[] }
    }
    expect(reply.card.meta.to).toBe('alice@example.com')
    expect(reply.card.meta.subject).toBe('Re: Hello there')
    expect(reply.card.html).toContain('<p>')
    expect(reply.thread.cards).toHaveLength(2)

    const loaded = (await (
      await request(`/mail-plugin/api/ai/thread?accountId=${accountId}&key=${encodeURIComponent(key)}`)
    ).json()) as { thread: { cards: unknown[] } }
    expect(loaded.thread.cards).toHaveLength(2)

    const removed = (await (
      await request(
        `/mail-plugin/api/ai/cards?accountId=${accountId}&key=${encodeURIComponent(key)}&cardId=${summary.card.id}`,
        { method: 'DELETE', headers: { origin: base } },
      )
    ).json()) as { thread: { cards: unknown[] } }
    expect(removed.thread.cards).toHaveLength(1)

    const cleared = await request(
      `/mail-plugin/api/ai/thread?accountId=${accountId}&key=${encodeURIComponent(key)}`,
      { method: 'DELETE', headers: { origin: base } },
    )
    expect(cleared.status).toBe(200)
  })

  it('composes and rewrites bodies through /ai/compose', async () => {
    const result = (await (
      await request('/mail-plugin/api/ai/compose', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, mode: 'polish', html: '<p>原文</p>', language: 'zh' }),
      })
    ).json()) as { text: string; html: string }
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.html).toContain('<p>')
  })

  it('exports draft CRUD', async () => {
    const created = (await (
      await request('/mail-plugin/api/drafts', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'a@example.com', subject: 'Draft', html: '<p>x</p>' }),
      })
    ).json()) as { draft: { id: string; subject: string } }
    expect(created.draft.subject).toBe('Draft')

    const list = (await (await request('/mail-plugin/api/drafts')).json()) as { items: { id: string }[] }
    expect(list.items).toHaveLength(1)

    const removed = await request(`/mail-plugin/api/drafts/${created.draft.id}`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(removed.status).toBe(200)
  })
})

describe('http helpers', () => {
  it('matches method, path and params', () => {
    const router = new Router()
    router.get('/messages/:id', () => ({ ok: true }))
    expect(router.match('GET', '/messages/42')?.params.id).toBe('42')
    expect(router.match('POST', '/messages/42')).toBeNull()
    expect(router.match('GET', '/messages/42/read')).toBeNull()
  })

  it('accepts same-origin and dsh-app origins and rejects others', () => {
    const request = (headers: Record<string, string>): IncomingMessage =>
      ({ headers }) as unknown as IncomingMessage
    expect(isTrustedRequest(request({ origin: 'http://127.0.0.1:1234', host: '127.0.0.1:1234' }))).toBe(true)
    expect(isTrustedRequest(request({ origin: 'dsh-app://app', host: 'x' }))).toBe(true)
    expect(isTrustedRequest(request({ origin: 'https://evil.example', host: '127.0.0.1:1234' }))).toBe(false)
    expect(isTrustedRequest(request({ host: '127.0.0.1:1234' }))).toBe(true)
  })
})
