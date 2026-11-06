import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AiCard, AiThread } from '../shared/types.js'

const MAX_THREADS = 50
const MAX_CARDS_PER_THREAD = 50
const MAX_FILE_BYTES = 2 * 1024 * 1024

interface ThreadFile {
  version: 1
  threads: Record<string, AiThread>
}

/**
 * Per-account store for AI cards.
 *
 * Cards persist so closing the panel, switching mail or restarting DSH never
 * loses an AI result. The file is capped: oldest threads are dropped first,
 * then the oldest cards inside a thread.
 */
export class AiThreadStore {
  private readonly file: string
  private cache: ThreadFile | null = null

  constructor(file: string) {
    this.file = file
  }

  private load(): ThreadFile {
    if (this.cache !== null) return this.cache
    let parsed: unknown = null
    try {
      if (existsSync(this.file)) parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    const threads =
      parsed !== null && typeof parsed === 'object' && (parsed as ThreadFile).threads !== undefined
        ? (parsed as ThreadFile).threads
        : {}
    this.cache = { version: 1, threads: sanitize(threads) }
    return this.cache
  }

  private flush(): void {
    const data = this.load()
    prune(data)
    const text = `${JSON.stringify(data, null, 2)}\n`
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.tmp`
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  get(key: string): AiThread | null {
    const thread = this.load().threads[key]
    return thread === undefined ? null : { ...thread, cards: [...thread.cards] }
  }

  appendCard(input: {
    key: string
    accountId: string
    subject: string
    messageId?: string
    card: AiCard
  }): AiThread {
    const data = this.load()
    const now = new Date().toISOString()
    const existing = data.threads[input.key]
    const thread: AiThread = existing ?? {
      key: input.key,
      accountId: input.accountId,
      subject: input.subject,
      messageId: input.messageId ?? '',
      cards: [],
      updatedAt: now,
    }
    thread.accountId = input.accountId
    thread.subject = input.subject
    if (input.messageId !== undefined && input.messageId !== '') thread.messageId = input.messageId
    thread.cards.push(input.card)
    thread.updatedAt = now
    data.threads[input.key] = thread
    this.flush()
    return { ...thread, cards: [...thread.cards] }
  }

  removeCard(key: string, cardId: string): AiThread | null {
    const data = this.load()
    const thread = data.threads[key]
    if (thread === undefined) return null
    thread.cards = thread.cards.filter((card) => card.id !== cardId)
    thread.updatedAt = new Date().toISOString()
    if (thread.cards.length === 0) {
      delete data.threads[key]
      this.flush()
      return null
    }
    this.flush()
    return { ...thread, cards: [...thread.cards] }
  }

  clear(key: string): boolean {
    const data = this.load()
    if (data.threads[key] === undefined) return false
    delete data.threads[key]
    this.flush()
    return true
  }

  /** Number of threads, for the settings page. */
  size(): number {
    return Object.keys(this.load().threads).length
  }
}

function sanitize(input: unknown): Record<string, AiThread> {
  if (input === null || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const result: Record<string, AiThread> = {}
  for (const [key, raw] of Object.entries(source)) {
    if (raw === null || typeof raw !== 'object') continue
    const thread = raw as Partial<AiThread>
    if (typeof thread.accountId !== 'string' || !Array.isArray(thread.cards)) continue
    const cards: AiCard[] = thread.cards
      .filter(
        (card): card is AiCard => card !== null && typeof card === 'object' && typeof card.id === 'string',
      )
      .map((card) => ({
        id: card.id,
        kind: card.kind,
        instruction: String(card.instruction ?? ''),
        output: String(card.output ?? ''),
        ...(typeof card.html === 'string' ? { html: card.html } : {}),
        ...(card.meta !== undefined ? { meta: card.meta } : {}),
        provider: String(card.provider ?? ''),
        model: String(card.model ?? ''),
        createdAt: String(card.createdAt ?? ''),
      }))
    result[key] = {
      key,
      accountId: thread.accountId,
      subject: String(thread.subject ?? ''),
      messageId: String(thread.messageId ?? ''),
      cards,
      updatedAt: String(thread.updatedAt ?? ''),
    }
  }
  return result
}

function prune(data: ThreadFile): void {
  const entries = Object.entries(data.threads).sort((left, right) =>
    right[1].updatedAt.localeCompare(left[1].updatedAt),
  )
  const kept = new Map(entries.slice(0, MAX_THREADS))
  for (const thread of kept.values()) {
    if (thread.cards.length > MAX_CARDS_PER_THREAD) {
      thread.cards = thread.cards.slice(-MAX_CARDS_PER_THREAD)
    }
  }
  data.threads = Object.fromEntries(kept)
  let size = JSON.stringify(data).length
  while (size > MAX_FILE_BYTES && kept.size > 1) {
    const oldest = [...kept.entries()].sort((left, right) =>
      left[1].updatedAt.localeCompare(right[1].updatedAt),
    )[0]
    if (oldest === undefined) break
    kept.delete(oldest[0])
    data.threads = Object.fromEntries(kept)
    size = JSON.stringify(data).length
  }
}
