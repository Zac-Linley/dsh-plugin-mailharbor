import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DraftStore } from '../src/host/drafts.js'
import { draftMime } from '../src/host/draft-mime.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-drafts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('draft IMAP mirror', () => {
  it('keeps remote uid fields across saves', () => {
    const store = new DraftStore(join(dir, 'drafts.json'), 'acc')
    const draft = store.save({ to: 'a@b.com', subject: 'Hi', html: '<p>x</p>', attachments: [] })
    const updated = store.save({ ...draft, remoteUid: 42, remoteMailbox: 'Drafts' })
    expect(updated.remoteUid).toBe(42)
    expect(store.get(draft.id)?.remoteMailbox).toBe('Drafts')
  })

  it('builds a multipart message with the attachment', async () => {
    const draft = {
      id: 'd1',
      accountId: 'acc',
      to: 'a@b.com',
      cc: '',
      bcc: '',
      subject: '同步测试',
      html: '<p>hello</p>',
      attachments: [
        { filename: 'note.txt', contentType: 'text/plain', data: Buffer.from('hi').toString('base64') },
      ],
      updatedAt: new Date().toISOString(),
    }
    const raw = await draftMime({ email: 'me@example.com', smtp: { fromName: 'Me' } }, draft)
    const text = raw.toString('utf8')
    expect(text).toContain('note.txt')
    expect(text).toMatch(/Subject:/)
    expect(text).toContain('multipart/mixed')
  })
})
