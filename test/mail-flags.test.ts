import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailFlagsStore } from '../src/host/mail-flags.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-flags-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MailFlagsStore', () => {
  it('persists stars per message key', () => {
    const store = new MailFlagsStore(join(dir, 'starred.json'))
    expect(store.has('mid:a@b')).toBe(false)
    store.set('mid:a@b', true)
    store.set('mid:c@d', true)
    expect(store.has('mid:a@b')).toBe(true)
    expect(new MailFlagsStore(join(dir, 'starred.json')).has('mid:c@d')).toBe(true)
    store.set('mid:a@b', false)
    expect(store.has('mid:a@b')).toBe(false)
  })
})
