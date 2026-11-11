import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMailSchema } from '../src/host/mail-db.js'
import { backfillReferences, extractReferences } from '../src/host/references.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-refs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reference backfill', () => {
  it('extracts In-Reply-To and References from raw headers', () => {
    const raw = Buffer.from(
      'From: a@example.com\r\nMessage-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\nReferences: <root@example.com> <a@example.com>\r\n\r\nbody',
    )
    expect(extractReferences(raw, 'b@example.com')).toEqual({
      inReplyTo: 'a@example.com',
      references: 'root@example.com a@example.com',
    })
  })

  it('fills columns and marks rows indexed', () => {
    const file = join(dir, 'mail.db')
    ensureMailSchema(file)
    const db = new DatabaseSync(file)
    db.prepare('INSERT INTO emails (mailbox, subject, message_id, raw_eml) VALUES (?, ?, ?, ?)').run(
      'INBOX',
      'Re: x',
      'b@example.com',
      Buffer.from('Message-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\n\r\nbody'),
    )
    db.close()
    const result = backfillReferences(file)
    expect(result.updated).toBe(1)
    expect(result.remaining).toBe(0)
    const check = new DatabaseSync(file)
    const row = check.prepare('SELECT in_reply_to, "references", refs_indexed FROM emails').get() as Record<
      string,
      unknown
    >
    check.close()
    expect(row.in_reply_to).toBe('a@example.com')
    expect(row.references).toBeNull()
    expect(row.refs_indexed).toBe(1)
  })
})
