import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMailSchema, MailDatabase } from '../src/host/mail-db.js'

let dir = ''
let file = ''

function insert(
  db: DatabaseSync,
  row: {
    mailbox: string
    uid: number
    subject: string
    from: string
    to: string
    date: string
    messageId: string
    text: string
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO emails (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id, body_text, body_html)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, '')`,
    )
    .run(
      row.mailbox,
      row.uid,
      row.subject,
      row.from,
      `${row.from}@example.com`,
      row.to,
      row.date,
      row.messageId,
      row.text,
    )
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-db-'))
  file = join(dir, 'mail.db')
  ensureMailSchema(file)
  const db = new DatabaseSync(file)
  insert(db, {
    mailbox: 'INBOX',
    uid: 1,
    subject: 'Quarterly budget review',
    from: 'Alice',
    to: 'me@example.com',
    date: '2026-11-01 09:00:00',
    messageId: 'm1@example.com',
    text: 'Please review the budget spreadsheet before Friday.',
  })
  insert(db, {
    mailbox: 'INBOX',
    uid: 2,
    subject: 'Lunch on Thursday?',
    from: 'Bob',
    to: 'me@example.com',
    date: '2026-11-02 12:30:00',
    messageId: 'm2@example.com',
    text: 'Want to grab lunch on Thursday?',
  })
  insert(db, {
    mailbox: 'Sent Items',
    uid: 3,
    subject: 'Re: Quarterly budget review',
    from: 'Me',
    to: 'Alice <alice@example.com>',
    date: '2026-11-01 10:00:00',
    messageId: 'm3@example.com',
    text: 'Reviewed, looks good.',
  })
  db.prepare(
    "INSERT INTO attachments (email_id, filename, content_type, size, hash) VALUES (1, 'budget.xlsx', 'application/vnd.ms-excel', 2048, 'abcd1234')",
  ).run()
  db.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MailDatabase', () => {
  it('reports totals and per-mailbox counts', () => {
    const store = new MailDatabase(file)
    expect(store.status()).toMatchObject({ ok: true, total: 3 })
    expect(store.mailboxes()).toEqual([
      { name: 'INBOX', count: 2 },
      { name: 'Sent Items', count: 1 },
    ])
  })

  it('lists newest first and pages', () => {
    const store = new MailDatabase(file)
    const page = store.list({ mailbox: 'INBOX', limit: 1, offset: 0 })
    expect(page.total).toBe(2)
    expect(page.items[0]?.subject).toBe('Lunch on Thursday?')
    const second = store.list({ mailbox: 'INBOX', limit: 1, offset: 1 })
    expect(second.items[0]?.subject).toBe('Quarterly budget review')
  })

  it('lists every mailbox when asked for all', () => {
    const store = new MailDatabase(file)
    const page = store.list({ mailbox: 'all', limit: 10 })
    expect(page.items).toHaveLength(3)
  })

  it('parses recipients and reports attachments', () => {
    const store = new MailDatabase(file)
    const page = store.list({ mailbox: 'INBOX', limit: 10 })
    const budget = page.items.find((item) => item.subject === 'Quarterly budget review')
    expect(budget?.from).toEqual({ name: 'Alice', address: 'Alice@example.com' })
    expect(budget?.hasAttachments).toBe(true)
    expect(budget?.snippet).toContain('budget spreadsheet')
  })

  it('searches subject and body', () => {
    const store = new MailDatabase(file)
    expect(store.list({ mailbox: 'all', query: 'budget' }).items.map((item) => item.subject)).toEqual([
      'Re: Quarterly budget review',
      'Quarterly budget review',
    ])
    expect(store.list({ mailbox: 'all', query: 'Thursday' }).total).toBe(1)
  })

  it('reads one message with attachment metadata', () => {
    const store = new MailDatabase(file)
    const detail = store.get(1)
    expect(detail?.subject).toBe('Quarterly budget review')
    expect(detail?.text).toContain('spreadsheet')
    expect(detail?.attachments).toEqual([
      { id: '1', filename: 'budget.xlsx', contentType: 'application/vnd.ms-excel', size: 2048 },
    ])
  })

  it('returns undefined for a missing message', () => {
    const store = new MailDatabase(file)
    expect(store.get(999)).toBeUndefined()
  })

  it('matches a Message-ID regardless of brackets', () => {
    const store = new MailDatabase(file)
    expect(store.hasMessageId('m1@example.com')).toBe(true)
    expect(store.hasMessageId('<m1@example.com>')).toBe(true)
    expect(store.hasMessageId('missing@example.com')).toBe(false)
  })
})
