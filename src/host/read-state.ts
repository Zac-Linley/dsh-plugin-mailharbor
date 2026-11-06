import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Local read state for archived mail.
 *
 * The backup database stores no IMAP flags, and most archived messages no
 * longer exist on the server. This store keeps only the keys the user marked
 * unread; every other message is treated as read. Server mail uses its own
 * `\Seen` flag and is mirrored here by message id when the two overlap.
 */
export class ReadStateStore {
  private readonly file: string
  private keys: Set<string> | null = null

  constructor(file: string) {
    this.file = file
  }

  private load(): Set<string> {
    if (this.keys !== null) return this.keys
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { unread?: unknown })?.unread)
          ? (parsed as { unread: unknown[] }).unread
          : []
      this.keys = new Set(list.filter((key): key is string => typeof key === 'string' && key !== ''))
    } catch {
      this.keys = new Set()
    }
    return this.keys
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.tmp`
    writeFileSync(temp, `${JSON.stringify({ unread: [...this.load()] }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temp, this.file)
  }

  isUnread(key: string): boolean {
    return key !== '' && this.load().has(key)
  }

  setUnread(key: string, unread: boolean): boolean {
    const normalized = key.trim()
    if (normalized === '') return false
    const keys = this.load()
    const has = keys.has(normalized)
    if (unread && !has) {
      keys.add(normalized)
      this.flush()
      return true
    }
    if (!unread && has) {
      keys.delete(normalized)
      this.flush()
      return true
    }
    return false
  }

  sync(entries: { key: string; unread: boolean }[]): void {
    let changed = false
    const keys = this.load()
    for (const entry of entries) {
      const key = String(entry.key ?? '').trim()
      if (key === '') continue
      if (entry.unread && !keys.has(key)) {
        keys.add(key)
        changed = true
      } else if (!entry.unread && keys.has(key)) {
        keys.delete(key)
        changed = true
      }
    }
    if (changed) this.flush()
  }

  count(): number {
    return this.load().size
  }

  list(): string[] {
    return [...this.load()]
  }
}
