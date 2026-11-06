import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiThreadStore } from '../src/host/ai-store.js'
import type { AiCard } from '../src/shared/types.js'

function card(overrides: Partial<AiCard> = {}): AiCard {
  return {
    id: `card-${Math.random().toString(16).slice(2)}`,
    kind: 'summary',
    instruction: '',
    output: '结论：需要复核预算。',
    provider: 'deepseek',
    model: 'deepseek-flash',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-threads-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AiThreadStore', () => {
  it('appends cards and persists them across instances', () => {
    const file = join(dir, 'ai-threads.json')
    const store = new AiThreadStore(file)
    expect(store.get('mid:a@example.com')).toBeNull()

    const thread = store.appendCard({
      key: 'mid:a@example.com',
      accountId: 'acc_1',
      subject: '预算复核',
      messageId: 'a@example.com',
      card: card(),
    })
    expect(thread.cards).toHaveLength(1)
    expect(thread.subject).toBe('预算复核')

    const reopened = new AiThreadStore(file)
    expect(reopened.get('mid:a@example.com')?.cards[0]?.output).toContain('复核预算')
  })

  it('keeps several cards in order and removes one', () => {
    const store = new AiThreadStore(join(dir, 'ai-threads.json'))
    const first = card({ output: '第一张' })
    const second = card({ output: '第二张', kind: 'reply' })
    store.appendCard({ key: 'k', accountId: 'acc_1', subject: 's', card: first })
    store.appendCard({ key: 'k', accountId: 'acc_1', subject: 's', card: second })
    expect(store.get('k')?.cards.map((entry) => entry.output)).toEqual(['第一张', '第二张'])

    const after = store.removeCard('k', first.id)
    expect(after?.cards).toHaveLength(1)
    expect(after?.cards[0]?.output).toBe('第二张')
    expect(store.removeCard('k', 'missing')).not.toBeNull()
  })

  it('drops the thread when its last card is removed, and clears on demand', () => {
    const store = new AiThreadStore(join(dir, 'ai-threads.json'))
    const only = card()
    store.appendCard({ key: 'k', accountId: 'acc_1', subject: 's', card: only })
    expect(store.removeCard('k', only.id)).toBeNull()
    expect(store.get('k')).toBeNull()

    store.appendCard({ key: 'k2', accountId: 'acc_1', subject: 's', card: card() })
    expect(store.clear('k2')).toBe(true)
    expect(store.clear('k2')).toBe(false)
    expect(store.size()).toBe(0)
  })

  it('caps cards per thread', () => {
    const store = new AiThreadStore(join(dir, 'ai-threads.json'))
    for (let index = 0; index < 60; index += 1) {
      store.appendCard({
        key: 'k',
        accountId: 'acc_1',
        subject: 's',
        card: card({
          output: `#${String(index)}`,
          createdAt: `2026-11-06T00:00:${String(index).padStart(2, '0')}.000Z`,
        }),
      })
    }
    const cards = store.get('k')?.cards ?? []
    expect(cards).toHaveLength(50)
    expect(cards[cards.length - 1]?.output).toBe('#59')
  })

  it('ignores a corrupt file instead of throwing', () => {
    const file = join(dir, 'ai-threads.json')
    const store = new AiThreadStore(file)
    store.appendCard({ key: 'k', accountId: 'acc_1', subject: 's', card: card() })
    rmSync(file)
    expect(new AiThreadStore(file).get('k')).toBeNull()
  })
})
