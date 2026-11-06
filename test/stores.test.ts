import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DraftStore } from '../src/host/drafts.js'
import { ReadStateStore } from '../src/host/read-state.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('DraftStore', () => {
  it('creates, updates, lists and removes drafts', () => {
    const store = new DraftStore(join(dir, 'drafts.json'), 'acc_1')
    const created = store.save({ subject: 'Hello', to: 'a@example.com', html: '<p>hi</p>' })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.accountId).toBe('acc_1')
    expect(store.list()).toHaveLength(1)

    const updated = store.save({ id: created.id, subject: 'Hello again', to: 'b@example.com', html: '' })
    expect(updated.subject).toBe('Hello again')
    expect(store.list()).toHaveLength(1)
    expect(store.get(created.id)?.to).toBe('b@example.com')

    expect(store.remove(created.id)).toBe(true)
    expect(store.remove(created.id)).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('starts empty when the file is missing or malformed', () => {
    const file = join(dir, 'drafts.json')
    const store = new DraftStore(file, 'acc_1')
    expect(store.list()).toEqual([])
    writeFileSync(file, '{not json')
    expect(store.list()).toEqual([])
  })
})

describe('ReadStateStore', () => {
  it('tracks unread keys and persists them', () => {
    const file = join(dir, 'read-state.json')
    const store = new ReadStateStore(file)
    expect(store.isUnread('mid:abc')).toBe(false)
    store.setUnread('mid:abc', true)
    expect(store.isUnread('mid:abc')).toBe(true)

    const reopened = new ReadStateStore(file)
    expect(reopened.isUnread('mid:abc')).toBe(true)
    expect(reopened.list()).toEqual(['mid:abc'])
  })

  it('mirrors a batch of server flags in one write', () => {
    const store = new ReadStateStore(join(dir, 'read-state.json'))
    store.sync([
      { key: 'mid:a', unread: true },
      { key: 'mid:b', unread: false },
    ])
    expect(store.list()).toEqual(['mid:a'])
    expect(store.count()).toBe(1)
  })
})
