import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AttachmentMeta, MessageDetail, MessageSummary, Page } from '../shared/types.js'
import { parseAddressList } from './address.js'
import { inlineCidImages } from './inline-images.js'

/** The layout the backup engine writes; read here by the panel and tools. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox TEXT NOT NULL,
    uid INTEGER,
    subject TEXT,
    from_name TEXT,
    from_addr TEXT,
    to_addr TEXT,
    cc TEXT,
    date TEXT,
    message_id TEXT UNIQUE,
    body_text TEXT,
    body_html TEXT,
    raw_eml BLOB,
    hash TEXT,
    backup_log_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    data BLOB,
    hash TEXT
  );
  CREATE TABLE IF NOT EXISTS backup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    mailboxes TEXT,
    new_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    total_emails INTEGER DEFAULT 0,
    cumulative_hash TEXT,
    status TEXT DEFAULT 'running',
    error_info TEXT
  );
  CREATE TABLE IF NOT EXISTS backup_state (
    mailbox TEXT PRIMARY KEY,
    uid_validity TEXT,
    last_uid INTEGER,
    updated_at TEXT
  );
`

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox, date);
  CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
  CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
`

const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, from_name, from_addr, to_addr, cc, body_text, att_filename,
  content='', tokenize='trigram'
)`

/** Create the mail database layout, including the search index when available. */
export function ensureMailSchema(file: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(SCHEMA)
    db.exec(INDEXES)
    try {
      db.exec(FTS)
    } catch {
      // A build without FTS5 still backs up mail; search falls back to LIKE.
    }
    // Inline images (signature logos, cid images) were stored as attachments
    // before these columns existed; keep the schema forward-compatible.
    const columns = db.prepare('PRAGMA table_info(attachments)').all() as { name?: string }[]
    if (!columns.some((column) => column.name === 'content_id')) {
      db.exec('ALTER TABLE attachments ADD COLUMN content_id TEXT')
    }
    if (!columns.some((column) => column.name === 'disposition')) {
      db.exec('ALTER TABLE attachments ADD COLUMN disposition TEXT')
    }
  } finally {
    db.close()
  }
}

export interface UnreadKeys {
  mids: string[]
  ids: number[]
}

export interface ListQuery {
  mailbox?: string
  query?: string
  offset?: number
  limit?: number
  since?: string
  order?: 'newest' | 'oldest'
  /** Only messages whose key is in the local unread set. */
  unread?: UnreadKeys
  /** Sender name or address contains this text. */
  from?: string
  /** Only messages with at least one attachment. */
  attachmentsOnly?: boolean
  /** ISO date (inclusive) and exclusive end date. */
  before?: string
}

export interface MailDatabaseOptions {
  /** Hard cap on stored body text returned to the reader. */
  maxBodyChars?: number
  /** Root that holds content-addressed attachment files. */
  attachmentsRoot?: string
}

/**
 * Read-only view over one account's mail backup.
 *
 * The backup engine owns the file; this class never writes to it and opens it
 * with SQLITE_OPEN_READONLY. A single connection is reused because opening a
 * large database per request is wasteful.
 */
export class MailDatabase {
  private readonly file: string
  private readonly options: MailDatabaseOptions
  private db: DatabaseSync | undefined
  private ftsChecked = false
  private ftsAvailable = false

  constructor(file: string, options: MailDatabaseOptions = {}) {
    this.file = file
    this.options = options
  }

  get path(): string {
    return this.file
  }

  isOpen(): boolean {
    return this.db !== undefined
  }

  open(): DatabaseSync {
    if (this.db !== undefined) return this.db
    if (!existsSync(this.file)) throw new Error(`邮件数据库不存在: ${this.file}`)
    this.db = new DatabaseSync(this.file, { readOnly: true })
    this.db.exec('PRAGMA busy_timeout = 3000')
    return this.db
  }

  /** Whether the backup has added inline-image columns yet. */
  private hasAttachmentColumns(): boolean {
    try {
      const columns = this.open().prepare('PRAGMA table_info(attachments)').all() as { name?: string }[]
      return columns.some((column) => column.name === 'content_id')
    } catch {
      return false
    }
  }

  private attachmentCountSql(): string {
    if (!this.hasAttachmentColumns()) {
      return '(SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id) AS attachment_count'
    }
    return `(SELECT COUNT(*) FROM attachments a
          WHERE a.email_id = e.id
            AND NOT (a.content_type LIKE 'image/%' AND (
              a.disposition = 'inline'
              OR (a.content_id IS NOT NULL AND a.content_id <> '' AND a.disposition IS NOT 'attachment')
              OR lower(a.filename) GLOB 'image[0-9]*'
            ))) AS attachment_count`
  }

  close(): void {
    if (this.db === undefined) return
    try {
      this.db.close()
    } catch {
      // Closing an already-closed handle is harmless.
    }
    this.db = undefined
  }

  status(): { ok: boolean; database: string; total: number; error?: string } {
    try {
      const row = this.open().prepare('SELECT COUNT(*) AS count FROM emails').get()
      return { ok: true, database: this.file, total: Number(row?.count ?? 0) }
    } catch (error) {
      return { ok: false, database: this.file, total: 0, error: messageOf(error) }
    }
  }

  /** Per-mailbox counts, largest first. */
  mailboxes(): { name: string; count: number }[] {
    const rows = this.open()
      .prepare('SELECT mailbox, COUNT(*) AS count FROM emails GROUP BY mailbox ORDER BY count DESC')
      .all()
    return rows.map((row) => ({ name: String(row.mailbox), count: Number(row.count ?? 0) }))
  }

  private supportsFts(): boolean {
    if (this.ftsChecked) return this.ftsAvailable
    this.ftsChecked = true
    try {
      const row = this.open()
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'emails_fts'")
        .get()
      this.ftsAvailable = row !== undefined
    } catch {
      this.ftsAvailable = false
    }
    return this.ftsAvailable
  }

  list(query: ListQuery = {}): Page<MessageSummary> {
    const db = this.open()
    const mailbox = String(query.mailbox ?? 'all')
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 40)))
    const where: string[] = []
    const params: (string | number)[] = []
    if (mailbox !== '' && mailbox !== 'all') {
      where.push('e.mailbox = ?')
      params.push(mailbox)
    }
    if (typeof query.since === 'string' && query.since !== '') {
      where.push('e.date >= ?')
      params.push(query.since)
    }
    if (typeof query.before === 'string' && query.before !== '') {
      where.push('e.date < ?')
      params.push(query.before.length === 10 ? `${query.before} 23:59:59` : query.before)
    }
    if (typeof query.from === 'string' && query.from.trim() !== '') {
      const needle = `%${query.from.trim().toLowerCase()}%`
      where.push('(lower(e.from_addr) LIKE ? OR lower(e.from_name) LIKE ?)')
      params.push(needle, needle)
    }
    if (query.attachmentsOnly === true) {
      where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)')
    }
    if (query.unread !== undefined) {
      const mids = query.unread.mids.slice(0, 500)
      const ids = query.unread.ids.slice(0, 500)
      if (mids.length === 0 && ids.length === 0) {
        return { items: [], total: 0, offset, limit }
      }
      const parts: string[] = []
      if (mids.length > 0) {
        parts.push(`e.message_id IN (${mids.map(() => '?').join(',')})`)
        params.push(...mids)
      }
      if (ids.length > 0) {
        parts.push(`e.id IN (${ids.map(() => '?').join(',')})`)
        params.push(...ids)
      }
      where.push(`(${parts.join(' OR ')})`)
    }
    const text = String(query.query ?? '').trim()
    if (text !== '') {
      const tokens = text.split(/\s+/).filter(Boolean)
      const short = tokens.some((token) => token.length < 3)
      if (!short && this.supportsFts()) {
        const like = `%${text}%`
        where.push(
          '(e.id IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?) OR e.subject LIKE ? OR e.from_name LIKE ? OR e.from_addr LIKE ? OR e.to_addr LIKE ?)',
        )
        params.push(tokens.map(quoteMatch).join(' AND '), like, like, like, like)
      } else {
        for (const token of tokens) {
          const like = `%${token}%`
          where.push(
            '(e.subject LIKE ? OR e.from_name LIKE ? OR e.from_addr LIKE ? OR e.to_addr LIKE ? OR e.body_text LIKE ?)',
          )
          params.push(like, like, like, like, like)
        }
      }
    }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    const columns = `SELECT e.id, e.mailbox, e.uid, e.subject, e.from_name, e.from_addr, e.to_addr, e.cc,
        e.message_id, e.date, length(e.body_text) AS text_length,
        ${this.attachmentCountSql()},
        substr(COALESCE(e.body_text, ''), 1, 240) AS snippet`
    const total = Number(
      db.prepare(`SELECT COUNT(*) AS count FROM emails e ${clause}`).get(...params)?.count ?? 0,
    )
    const direction = query.order === 'oldest' ? 'ASC' : 'DESC'
    const rows = db
      .prepare(
        `${columns} FROM emails e ${clause} ORDER BY e.date ${direction}, e.id ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
    return { items: rows.map((row) => rowToSummary(row as Record<string, unknown>)), total, offset, limit }
  }

  /** Structured search used by AI search (keywords + sender + dates). */
  searchAdvanced(options: {
    mailbox?: string
    keywords?: string[]
    from?: string
    subject?: string
    since?: string
    before?: string
    limit?: number
  }): Page<MessageSummary> {
    const db = this.open()
    const where: string[] = []
    const params: (string | number)[] = []
    const mailbox = String(options.mailbox ?? 'all')
    if (mailbox !== '' && mailbox !== 'all') {
      where.push('e.mailbox = ?')
      params.push(mailbox)
    }
    const keywords = (options.keywords ?? []).filter((keyword) => keyword !== '')
    if (keywords.length > 0) {
      const clauses: string[] = []
      for (const keyword of keywords) {
        clauses.push(
          '(e.subject LIKE ? OR e.from_name LIKE ? OR e.from_addr LIKE ? OR e.to_addr LIKE ? OR e.body_text LIKE ?)',
        )
        const like = `%${keyword}%`
        params.push(like, like, like, like, like)
      }
      where.push(`(${clauses.join(' OR ')})`)
    }
    if ((options.from ?? '') !== '') {
      const like = `%${String(options.from)}%`
      where.push('(e.from_name LIKE ? OR e.from_addr LIKE ?)')
      params.push(like, like)
    }
    if ((options.subject ?? '') !== '') {
      where.push('e.subject LIKE ?')
      params.push(`%${String(options.subject)}%`)
    }
    if ((options.since ?? '') !== '') {
      where.push('substr(e.date, 1, 10) >= ?')
      params.push(String(options.since))
    }
    if ((options.before ?? '') !== '') {
      where.push('substr(e.date, 1, 10) <= ?')
      params.push(String(options.before))
    }
    const limit = Math.min(100, Math.max(1, options.limit ?? 60))
    if (where.length === 0) return { items: [], total: 0, offset: 0, limit }
    const clause = `WHERE ${where.join(' AND ')}`
    const columns = `SELECT e.id, e.mailbox, e.uid, e.subject, e.from_name, e.from_addr, e.to_addr, e.cc,
        e.message_id, e.date, length(e.body_text) AS text_length,
        ${this.attachmentCountSql()},
        substr(COALESCE(e.body_text, ''), 1, 240) AS snippet`
    const total = Number(
      db.prepare(`SELECT COUNT(*) AS count FROM emails e ${clause}`).get(...params)?.count ?? 0,
    )
    const rows = db
      .prepare(`${columns} FROM emails e ${clause} ORDER BY e.date DESC, e.id DESC LIMIT ?`)
      .all(...params, limit)
    return { items: rows.map((row) => rowToSummary(row as Record<string, unknown>)), total, offset: 0, limit }
  }

  /** Frequent senders and recipients, for compose autocomplete. */
  contacts(query = '', limit = 50): { name: string; address: string; count: number }[] {
    const text = query.trim().toLowerCase()
    const counts = new Map<string, { name: string; address: string; count: number }>()
    const add = (name: string, address: string): void => {
      const key = address.toLowerCase()
      if (key === '' || !key.includes('@')) return
      const existing = counts.get(key)
      if (existing === undefined) counts.set(key, { name, address, count: 1 })
      else {
        existing.count += 1
        if (existing.name === '' && name !== '') existing.name = name
      }
    }
    try {
      const db = this.open()
      for (const row of db
        .prepare(
          `SELECT from_name AS name, from_addr AS address FROM emails
           WHERE from_addr <> '' AND from_addr LIKE '%@%' ORDER BY date DESC LIMIT 3000`,
        )
        .all() as { name?: string; address?: string }[]) {
        add(String(row.name ?? ''), String(row.address ?? ''))
      }
      for (const row of db
        .prepare(
          `SELECT to_addr AS address, cc AS copies FROM emails
           WHERE (to_addr <> '' OR cc <> '') ORDER BY date DESC LIMIT 1500`,
        )
        .all() as { address?: string; copies?: string }[]) {
        for (const entry of parseAddressList(String(row.address ?? ''))) add(entry.name, entry.address)
        for (const entry of parseAddressList(String(row.copies ?? ''))) add(entry.name, entry.address)
      }
    } catch {
      return []
    }
    return [...counts.values()]
      .filter(
        (entry) =>
          text === '' ||
          entry.address.toLowerCase().includes(text) ||
          entry.name.toLowerCase().includes(text),
      )
      .sort((left, right) => right.count - left.count)
      .slice(0, limit)
  }

  /** All archived messages in the same conversation (normalized subject). */
  thread(subject: string, limit = 200): MessageSummary[] {
    const normalize = (value: string): string =>
      value
        .replace(/^(\s*(re|fw|fwd|回复|转发)\s*[:：]\s*)+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    const base = normalize(subject)
    if (base === '') return []
    const page = this.list({ mailbox: 'all', query: base, limit: Math.min(500, limit * 2) })
    return page.items.filter((item) => normalize(item.subject) === base).slice(0, limit)
  }

  /** Number of unread keys that still exist in this backup. */
  countUnread(keys: UnreadKeys): number {
    const mids = keys.mids.slice(0, 500)
    const ids = keys.ids.slice(0, 500)
    if (mids.length === 0 && ids.length === 0) return 0
    const parts: string[] = []
    const params: (string | number)[] = []
    if (mids.length > 0) {
      parts.push(`message_id IN (${mids.map(() => '?').join(',')})`)
      params.push(...mids)
    }
    if (ids.length > 0) {
      parts.push(`id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    try {
      const row = this.open()
        .prepare(`SELECT COUNT(*) AS count FROM emails WHERE ${parts.join(' OR ')}`)
        .get(...params)
      return Number(row?.count ?? 0)
    } catch {
      return 0
    }
  }

  get(localId: number): MessageDetail | undefined {
    const db = this.open()
    const row = db
      .prepare(
        `SELECT id, mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id,
                body_text, body_html
         FROM emails WHERE id = ?`,
      )
      .get(localId)
    if (row === undefined) return undefined
    const bodyHtml = String(row.body_html ?? '')
    const cidText = bodyHtml.toLowerCase()
    const wantsInline = cidText.includes('cid:')
    const attachmentColumns = this.hasAttachmentColumns()
      ? 'id, filename, content_type, size, content_id, disposition'
      : 'id, filename, content_type, size'
    const rows = db
      .prepare(
        `SELECT ${attachmentColumns}${wantsInline ? ', data, hash' : ''} FROM attachments WHERE email_id = ? ORDER BY id`,
      )
      .all(localId)
    const attachments = rows
      .filter((item: Record<string, unknown>) => {
        const type = String(item.content_type ?? '').toLowerCase()
        if (!type.startsWith('image/')) return true
        const disposition = String(item.disposition ?? '').toLowerCase()
        const contentId = String(item.content_id ?? '').toLowerCase()
        if (disposition === 'inline') return false
        if (contentId !== '' && disposition !== 'attachment') return false
        // Legacy rows: an image whose filename appears in a cid: reference is inline.
        const filename = String(item.filename ?? '').toLowerCase()
        if (filename !== '' && cidText.includes(`cid:${filename}`)) return false
        if (/^image\d+\.[a-z0-9]+$/.test(filename)) return false
        return true
      })
      .map((item: Record<string, unknown>): AttachmentMeta => ({
        id: String(item.id),
        filename: String(item.filename ?? 'attachment'),
        contentType: String(item.content_type ?? 'application/octet-stream'),
        size: Number(item.size ?? 0),
      }))
    const max = this.options.maxBodyChars ?? 400_000
    const bodyText = String(row.body_text ?? '')
    const inlineImages = wantsInline
      ? (rows as Record<string, unknown>[])
          .filter((item) =>
            String(item.content_type ?? '')
              .toLowerCase()
              .startsWith('image/'),
          )
          .map((item) => ({
            cid:
              item.content_id === null || item.content_id === undefined ? undefined : String(item.content_id),
            filename: String(item.filename ?? ''),
            contentType: String(item.content_type ?? 'image/png'),
            data: this.attachmentBytes(item),
          }))
          .filter((item) => item.data !== undefined)
      : []
    return {
      ...rowToSummary(row),
      cc: parseAddressList(String(row.cc ?? '')),
      replyTo: [],
      text: truncate(bodyText, max),
      html: bodyHtml === '' ? null : truncate(inlineCidImages(bodyHtml, inlineImages), max * 2),
      attachments,
      references: [],
    }
  }

  private attachmentBytes(row: Record<string, unknown>): Uint8Array | undefined {
    const data = row.data
    if (data instanceof Uint8Array) return data
    const hash = typeof row.hash === 'string' ? row.hash : ''
    const root = this.options.attachmentsRoot ?? ''
    if (hash === '' || root === '') return undefined
    const file = `${root}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`
    if (!existsSync(file)) return undefined
    try {
      return readFileSyncSafe(file) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Read one attachment's bytes; the payload may live in a file (content-addressed). */
  attachment(
    emailId: number,
    attachmentId: number,
  ): { filename: string; contentType: string; data: Uint8Array } | undefined {
    const db = this.open()
    const row = db
      .prepare('SELECT filename, content_type, data, hash FROM attachments WHERE id = ? AND email_id = ?')
      .get(attachmentId, emailId)
    if (row === undefined) return undefined
    let data: Uint8Array | null = row.data instanceof Uint8Array ? row.data : null
    if (data === null && typeof row.hash === 'string' && row.hash !== '') {
      const root = this.options.attachmentsRoot ?? ''
      if (root !== '') {
        const file = `${root}/${row.hash.slice(0, 2)}/${row.hash.slice(2, 4)}/${row.hash}`
        if (existsSync(file)) data = readFileSyncSafe(file)
      }
    }
    if (data === null) return undefined
    return {
      filename: String(row.filename ?? 'attachment'),
      contentType: String(row.content_type ?? 'application/octet-stream'),
      data,
    }
  }

  /** Locate a local row by Message-ID, for links from tasks and projects. */
  findByMessageId(messageId: string): { id: number; mailbox: string } | undefined {
    const id = messageId.trim().replace(/^<|>$/g, '')
    if (id === '') return undefined
    const row = this.open().prepare('SELECT id, mailbox FROM emails WHERE message_id = ? LIMIT 1').get(id)
    if (row === undefined) return undefined
    return { id: Number(row.id), mailbox: String(row.mailbox ?? '') }
  }

  /** Whether the backup already holds a message with this Message-ID. */
  hasMessageId(messageId: string): boolean {
    const id = messageId.trim().replace(/^<|>$/g, '')
    if (id === '') return false
    try {
      return (
        this.open().prepare('SELECT 1 AS found FROM emails WHERE message_id = ? LIMIT 1').get(id) !==
        undefined
      )
    } catch {
      return false
    }
  }

  /** Recent sent messages, for learning the user's writing style. */
  sentMessages(limit = 100): { subject: string; text: string }[] {
    const rows = this.open()
      .prepare(
        `SELECT subject, body_text FROM emails
         WHERE lower(mailbox) LIKE '%sent%' OR mailbox LIKE '%已发送%'
         ORDER BY date DESC, id DESC LIMIT ?`,
      )
      .all(limit)
    return rows.map((row) => ({
      subject: String(row.subject ?? ''),
      text: String(row.body_text ?? ''),
    }))
  }

  /** Latest backup runs, for the settings page. */
  backupSummary(): {
    ok: boolean
    lastCompleted: Record<string, unknown> | null
    latest: Record<string, unknown> | null
    total: number
    error?: string
  } {
    try {
      const db = this.open()
      const lastCompleted =
        db
          .prepare(
            `SELECT id, started_at, completed_at, new_count, total_emails, status
             FROM backup_logs WHERE status = 'completed' ORDER BY id DESC LIMIT 1`,
          )
          .get() ?? null
      const latest =
        db
          .prepare(
            'SELECT id, started_at, completed_at, new_count, total_emails, status FROM backup_logs ORDER BY id DESC LIMIT 1',
          )
          .get() ?? null
      return {
        ok: true,
        lastCompleted: toPlain(lastCompleted),
        latest: toPlain(latest),
        total: Number(db.prepare('SELECT COUNT(*) AS count FROM emails').get()?.count ?? 0),
      }
    } catch (error) {
      return { ok: false, lastCompleted: null, latest: null, total: 0, error: messageOf(error) }
    }
  }
}

function toPlain(row: unknown): Record<string, unknown> | null {
  if (row === undefined || row === null || typeof row !== 'object') return null
  return { ...(row as Record<string, unknown>) }
}

function readFileSyncSafe(file: string): Uint8Array | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n\n…（已截断）`
}

function quoteMatch(text: string): string {
  return `"${text.replaceAll('"', '""')}"`
}

function rowToSummary(row: Record<string, unknown>): MessageSummary {
  const fromName = String(row.from_name ?? '')
  const fromAddr = String(row.from_addr ?? '')
  return {
    id: String(row.id),
    accountId: '',
    uid: row.uid === null || row.uid === undefined ? undefined : Number(row.uid),
    messageId: String(row.message_id ?? ''),
    subject: String(row.subject ?? '(无主题)'),
    from: { name: fromName, address: fromAddr },
    to: parseAddressList(String(row.to_addr ?? '')),
    date: String(row.date ?? ''),
    unread: false,
    flagged: false,
    hasAttachments: Number(row.attachment_count ?? 0) > 0,
    snippet: String(row.snippet ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    mailbox: String(row.mailbox ?? ''),
  }
}
