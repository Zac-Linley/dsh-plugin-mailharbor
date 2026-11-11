import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Local star overlay; IMAP flags are mirrored when the message exists there. */
export class MailFlagsStore {
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
        : Array.isArray((parsed as { starred?: unknown })?.starred)
          ? (parsed as { starred: unknown[] }).starred
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
    writeFileSync(temp, `${JSON.stringify({ starred: [...this.load()] }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temp, this.file)
  }

  has(key: string): boolean {
    return key !== '' && this.load().has(key)
  }

  set(key: string, starred: boolean): boolean {
    const normalized = key.trim()
    if (normalized === '') return false
    const keys = this.load()
    const has = keys.has(normalized)
    if (starred && !has) {
      keys.add(normalized)
      this.flush()
      return true
    }
    if (!starred && has) {
      keys.delete(normalized)
      this.flush()
      return true
    }
    return false
  }
}
