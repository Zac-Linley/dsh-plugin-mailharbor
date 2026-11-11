import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface QueuedAction {
  id: string
  createdAt: string
  type: 'flag' | 'move'
  mailbox: string
  uid: number
  flag?: string
  value?: boolean
  target?: string
  attempts?: number
}

export interface ActionExecutor {
  setFlag(mailbox: string, uid: number, flag: string, value: boolean): Promise<void>
  move(mailbox: string, uid: number, target: string): Promise<void>
}

/** Durable queue for server-side actions that failed while offline. */
export class ActionQueueStore {
  private readonly file: string
  private items: QueuedAction[] | null = null

  constructor(file: string) {
    this.file = file
  }

  private load(): QueuedAction[] {
    if (this.items !== null) return this.items
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      this.items = Array.isArray(parsed)
        ? (parsed as QueuedAction[]).filter((item) => typeof item?.id === 'string')
        : []
    } catch {
      this.items = []
    }
    return this.items
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.load(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }

  list(): QueuedAction[] {
    return [...this.load()]
  }

  enqueue(action: Omit<QueuedAction, 'id' | 'createdAt'>): void {
    const items = this.load()
    // Keep one pending action per message and operation.
    const filtered = items.filter(
      (item) =>
        !(
          item.type === action.type &&
          item.mailbox === action.mailbox &&
          item.uid === action.uid &&
          (action.type === 'move' || item.flag === action.flag)
        ),
    )
    filtered.push({ ...action, id: randomUUID(), createdAt: new Date().toISOString() })
    this.items = filtered
    this.flush()
  }

  remove(ids: string[]): void {
    if (ids.length === 0) return
    const set = new Set(ids)
    this.items = this.load().filter((item) => !set.has(item.id))
    this.flush()
  }

  /** Try every queued action; keep the ones the server still rejects. */
  async flushTo(executor: ActionExecutor): Promise<{ sent: number; failed: number }> {
    const pending = this.list()
    const done: string[] = []
    let failed = 0
    for (const action of pending) {
      try {
        if (action.type === 'flag') {
          await executor.setFlag(
            action.mailbox,
            action.uid,
            action.flag ?? '\\Flagged',
            action.value !== false,
          )
        } else if (action.target !== undefined) {
          await executor.move(action.mailbox, action.uid, action.target)
        }
        done.push(action.id)
      } catch {
        failed += 1
        const current = this.load().find((item) => item.id === action.id)
        if (current !== undefined) {
          current.attempts = (current.attempts ?? 0) + 1
          if (current.attempts >= 5) done.push(action.id)
        }
      }
    }
    this.remove(done)
    return { sent: done.length, failed }
  }
}
