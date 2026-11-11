import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActionQueueStore } from '../src/host/action-queue.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-actions-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ActionQueueStore', () => {
  it('deduplicates a flag per message and survives reloads', () => {
    const file = join(dir, 'queue.json')
    const queue = new ActionQueueStore(file)
    queue.enqueue({ type: 'flag', mailbox: 'INBOX', uid: 7, flag: '\\Flagged', value: true })
    queue.enqueue({ type: 'flag', mailbox: 'INBOX', uid: 7, flag: '\\Flagged', value: false })
    expect(new ActionQueueStore(file).list()).toHaveLength(1)
  })

  it('keeps failures, removes successes and drops after five attempts', async () => {
    const queue = new ActionQueueStore(join(dir, 'queue.json'))
    queue.enqueue({ type: 'move', mailbox: 'INBOX', uid: 9, target: 'Archive' })
    queue.enqueue({ type: 'flag', mailbox: 'INBOX', uid: 10, flag: '\\Seen', value: true })
    const executor = {
      setFlag: async () => Promise.resolve(),
      move: async () => Promise.reject(new Error('offline')),
    }
    const first = await queue.flushTo(executor)
    expect(first.sent).toBe(1)
    expect(first.failed).toBe(1)
    expect(queue.list()).toHaveLength(1)
    for (let index = 0; index < 5; index += 1) await queue.flushTo(executor)
    expect(queue.list()).toHaveLength(0)
  })
})
