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
  saveAccounts([account], account.id)

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

  runtime = new MailHarborRuntime()
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
    expect(folders.items).toEqual([{ name: 'INBOX', count: 1 }])

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
