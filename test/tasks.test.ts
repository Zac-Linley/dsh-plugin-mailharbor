import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../src/host/tasks.js'

let dir = ''
let store: TaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-tasks-'))
  store = new TaskStore(join(dir, 'state.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('TaskStore', () => {
  it('creates, updates and removes a local task', () => {
    const task = store.create({
      accountId: 'acc_1',
      title: '确认报价',
      due: '2026-11-13',
      messageKey: 'mid:m1',
      messageSubject: '报价确认',
    })
    expect(task.dirty).toBe(true)
    expect(store.list({ accountId: 'acc_1' })).toHaveLength(1)

    const done = store.update(task.id, { status: 'COMPLETED' })
    expect(done.status).toBe('COMPLETED')
    expect(done.completedAt).not.toBeNull()
    expect(store.list({ accountId: 'acc_1', status: 'COMPLETED' })).toHaveLength(1)

    expect(store.remove(task.id)).toBe(true)
    expect(store.list({ accountId: 'acc_1' })).toHaveLength(0)
  })

  it('applies remote tasks without overwriting local edits', () => {
    const local = store.create({ accountId: 'acc_1', title: '本地标题' })
    store.applyRemote({
      accountId: 'acc_1',
      calendarHref: 'https://dav/cal/',
      href: 'https://dav/cal/a.ics',
      etag: '"1"',
      todo: {
        uid: 'remote-1',
        title: '远端标题',
        notes: '',
        due: '',
        status: 'NEEDS-ACTION',
        priority: 0,
        completedAt: null,
      },
    })
    expect(store.list({ accountId: 'acc_1' })).toHaveLength(2)

    // A clean remote row updates in place.
    store.applyRemote({
      accountId: 'acc_1',
      calendarHref: 'https://dav/cal/',
      href: 'https://dav/cal/a.ics',
      etag: '"2"',
      todo: {
        uid: 'remote-1',
        title: '远端标题 v2',
        notes: '',
        due: '2026-12-01',
        status: 'NEEDS-ACTION',
        priority: 3,
        completedAt: null,
      },
    })
    const remote = store.list({ accountId: 'acc_1' }).find((task) => task.uid === 'remote-1')
    expect(remote?.title).toBe('远端标题 v2')
    expect(remote?.due).toBe('2026-12-01')

    // The dirty local task keeps its edit even if the remote changed.
    store.applyRemote({
      accountId: 'acc_1',
      calendarHref: 'https://dav/cal/',
      href: 'https://dav/cal/b.ics',
      etag: '"1"',
      todo: {
        uid: local.uid,
        title: '远端覆盖',
        notes: '',
        due: '',
        status: 'NEEDS-ACTION',
        priority: 0,
        completedAt: null,
      },
    })
    expect(store.get(local.id)?.title).toBe('本地标题')
  })

  it('pushes dirty tasks and prunes missing remote rows', () => {
    const dirty = store.create({ accountId: 'acc_1', title: '待推送' })
    expect(store.pending('acc_1').map((task) => task.id)).toContain(dirty.id)

    store.markPushed(dirty.id, { href: 'https://dav/cal/x.ics', etag: '"1"', uid: dirty.uid })
    expect(store.pending('acc_1')).toHaveLength(0)
    expect(store.get(dirty.id)?.dirty).toBe(false)

    store.applyRemote({
      accountId: 'acc_1',
      calendarHref: 'https://dav/cal/',
      href: 'https://dav/cal/y.ics',
      etag: '"1"',
      todo: {
        uid: 'remote-y',
        title: '远端',
        notes: '',
        due: '',
        status: 'NEEDS-ACTION',
        priority: 0,
        completedAt: null,
      },
    })
    const removed = store.pruneMissingRemote('acc_1', 'https://dav/cal/', ['https://dav/cal/x.ics'])
    expect(removed).toBe(1)
    expect(store.list({ accountId: 'acc_1' }).map((task) => task.href)).toContain('https://dav/cal/x.ics')
  })
})
