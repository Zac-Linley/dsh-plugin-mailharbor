import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Draft, DraftAttachment } from '../shared/types.js'

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function isAttachment(value: unknown): value is DraftAttachment {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as DraftAttachment).filename === 'string' &&
    typeof (value as DraftAttachment).data === 'string'
  )
}

function isDraft(value: unknown): value is Draft {
  return value !== null && typeof value === 'object' && typeof (value as Draft).id === 'string'
}

export function draftPath(root: string): string {
  return join(root, 'drafts.json')
}

/**
 * JSON-file draft store per account. Drafts never touch the backup database,
 * and an atomic rename means a crash cannot leave a half-written file.
 */
export class DraftStore {
  private file: string
  private items: Draft[] = []
  private readonly accountId: string

  constructor(file: string, accountId: string) {
    this.file = file
    this.accountId = accountId
    this.load()
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      this.items = Array.isArray(parsed) ? parsed.filter(isDraft) : []
    } catch {
      this.items = []
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.${String(Date.now())}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }

  list(): Draft[] {
    return [...this.items]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((draft) => ({ ...draft }))
  }

  get(id: string): Draft | undefined {
    const found = this.items.find((draft) => draft.id === id)
    return found === undefined ? undefined : { ...found }
  }

  save(input: Partial<Draft> & { id?: string }): Draft {
    const now = new Date().toISOString()
    const existing = input.id === undefined ? undefined : this.items.find((draft) => draft.id === input.id)
    const fields = {
      to: text(input.to),
      cc: text(input.cc),
      bcc: text(input.bcc),
      subject: text(input.subject),
      html: text(input.html),
      attachments: Array.isArray(input.attachments)
        ? input.attachments.filter(isAttachment).map((file) => ({
            filename: text(file.filename).slice(0, 200),
            contentType: text(file.contentType).slice(0, 160),
            data: text(file.data),
          }))
        : [],
      inReplyTo: text(input.inReplyTo),
      references: text(input.references),
      ...(input.remoteUid === undefined
        ? existing?.remoteUid === undefined
          ? {}
          : { remoteUid: existing.remoteUid }
        : { remoteUid: Number(input.remoteUid) }),
      ...(input.remoteMailbox === undefined
        ? existing?.remoteMailbox === undefined
          ? {}
          : { remoteMailbox: existing.remoteMailbox }
        : { remoteMailbox: text(input.remoteMailbox) }),
    }
    if (existing !== undefined) {
      Object.assign(existing, fields, { updatedAt: now })
      this.flush()
      return { ...existing }
    }
    const draft: Draft = {
      id: randomUUID(),
      accountId: this.accountId,
      ...fields,
      updatedAt: now,
    }
    this.items.push(draft)
    this.flush()
    return { ...draft }
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((draft) => draft.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    this.flush()
    return true
  }

  location(): string {
    return this.file
  }
}
