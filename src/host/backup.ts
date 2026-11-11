import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { BackupStatus } from '../shared/types.js'
import { addressOf, formatAddressList, parseAddressList } from './address.js'
import type { AccountRuntime } from './config.js'
import { DatabaseSync } from 'node:sqlite'
import { ensureMailSchema } from './mail-db.js'
import { subjectKey } from './subject-key.js'
import type { ImapCredentials } from './imap.js'

export interface BackupEvent {
  mailbox?: string
  added?: number
  total?: number
  message: string
}

export interface BackupResult {
  ok: true
  newCount: number
  failCount: number
  total: number
  mailboxes: { name: string; added: number }[]
}

export interface BackupOptions {
  signal?: AbortSignal
  onEvent?: (event: BackupEvent) => void
  batchSize?: number
}

const BATCH = 25

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function normalizeId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .trim()
}

/** Local wall-clock stamp, matching what the previous backup tool wrote. */
function stamp(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : value === undefined || value === null
        ? undefined
        : new Date(String(value))
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('备份已取消')
    ;(error as { code?: string }).code = 'backup-cancelled'
    throw error
  }
}

/**
 * Incremental IMAP → SQLite backup for one account.
 *
 * It writes the same schema the previous tool created, so an existing database
 * keeps working. Messages are fetched by UID range (`lastUid+1:*`) instead of
 * enumerating every UID on each run, and each batch commits together with its
 * attachment files and search rows, so an interrupted run resumes cleanly.
 */
export class BackupEngine {
  private readonly runtime: AccountRuntime
  private readonly credentials: ImapCredentials
  readonly batchSize: number
  private readonly onFlags: ((entries: { key: string; unread: boolean }[]) => void) | undefined

  constructor(
    runtime: AccountRuntime,
    credentials: ImapCredentials,
    options: { batchSize?: number; onFlags?: (entries: { key: string; unread: boolean }[]) => void } = {},
  ) {
    this.runtime = runtime
    this.credentials = credentials
    this.batchSize = options.batchSize ?? BATCH
    this.onFlags = options.onFlags
  }

  /** Mirror IMAP \Seen flags into the local unread store. */
  private async reconcileReadState(client: ImapFlow): Promise<void> {
    if (this.onFlags === undefined) return
    const exists = Number((client.mailbox as { exists?: number } | undefined)?.exists ?? 0)
    if (exists === 0) return
    const entries = new Map<string, boolean>()
    const add = (messageId: string, unread: boolean): void => {
      if (messageId !== '') entries.set(`mid:${messageId}`, unread)
    }
    const flagsOf = (flags: unknown): string[] =>
      [...((flags ?? []) as Iterable<unknown>)].map((flag) => String(flag).toLowerCase())

    // Recent window: catches messages that were read (or unread) elsewhere.
    const start = Math.max(1, exists - 299)
    try {
      for await (const message of client.fetch(`${String(start)}:${String(exists)}`, {
        uid: true,
        envelope: true,
        flags: true,
      })) {
        const messageId = normalizeId((message as { envelope?: { messageId?: string } }).envelope?.messageId)
        add(messageId, !flagsOf(message.flags).includes('\\seen'))
      }
    } catch {
      // A partial window is still useful.
    }

    // Older unread messages anywhere in the mailbox: the window above may not
    // reach them, and the sidebar badge must match what the list shows.
    try {
      const unseen = await client.search({ seen: false }, { uid: true })
      const uids = (Array.isArray(unseen) ? unseen : []).map(Number).filter((uid) => Number.isFinite(uid))
      for (let index = 0; index < uids.length; index += 200) {
        const range = uids.slice(index, index + 200).join(',')
        if (range === '') continue
        for await (const message of client.fetch(
          range,
          { uid: true, envelope: true, flags: true },
          { uid: true },
        )) {
          const messageId = normalizeId(
            (message as { envelope?: { messageId?: string } }).envelope?.messageId,
          )
          add(messageId, true)
        }
      }
    } catch {
      // Search is an optimisation; the recent window already synced flags.
    }

    if (entries.size > 0) {
      this.onFlags([...entries.entries()].map(([key, unread]) => ({ key, unread })))
    }
  }

  private attachmentsDir(): string {
    return this.runtime.attachments
  }

  private openDb(): DatabaseSync {
    ensureMailSchema(this.runtime.mailDb)
    const db = new DatabaseSync(this.runtime.mailDb)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=10000')
    db.exec('PRAGMA synchronous=NORMAL')
    return db
  }

  private writeAttachment(data: Buffer): { hash: string; size: number } {
    const hash = sha256(data)
    const dir = join(this.attachmentsDir(), hash.slice(0, 2), hash.slice(2, 4))
    const file = join(dir, hash)
    mkdirSync(dir, { recursive: true })
    if (!existsSync(file)) writeFileSync(file, data, { mode: 0o600 })
    return { hash, size: data.length }
  }

  private insertEmail(
    db: DatabaseSync,
    mailbox: string,
    message: RawBackupMessage,
    parsed: Awaited<ReturnType<typeof simpleParser>>,
    logId: number,
  ): number {
    const source = message.source ?? Buffer.alloc(0)
    const hash = sha256(source)
    const from = parsed.from?.value?.[0] ?? { name: '', address: '' }
    const messageId = normalizeId(parsed.messageId ?? message.envelope?.messageId)
    const toText =
      parsedAddressText(parsed.to) || formatAddressList(parseAddressList(addressTextOf(message.envelope?.to)))
    const ccText =
      parsedAddressText(parsed.cc) || formatAddressList(parseAddressList(addressTextOf(message.envelope?.cc)))
    const subject = String(parsed.subject ?? message.envelope?.subject ?? '(无主题)')
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    const html = typeof parsed.html === 'string' ? parsed.html : ''
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO emails
           (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id,
            in_reply_to, "references", body_text, body_html, raw_eml, hash, backup_log_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mailbox,
        Number(message.uid),
        subject,
        String(from.name ?? ''),
        String(from.address ?? ''),
        toText,
        ccText,
        stamp(parsed.date ?? message.internalDate ?? message.envelope?.date),
        messageId === '' ? null : messageId,
        normalizeId(parsed.inReplyTo ?? '') || null,
        String(parsed.references ?? '')
          .split(/\s+/)
          .map(normalizeId)
          .filter((item) => item !== '')
          .join(' ') || null,
        text,
        html,
        source,
        hash,
        logId,
      )
    if (inserted.changes === 0) return 0
    const emailId = Number(inserted.lastInsertRowid)
    db.prepare('INSERT OR REPLACE INTO email_subjects (email_id, key) VALUES (?, ?)').run(
      emailId,
      subjectKey(subject),
    )
    const attachments = parsed.attachments ?? []
    const insertAttachment = db.prepare(
      'INSERT INTO attachments (email_id, filename, content_type, size, hash, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const attachment of attachments) {
      const data = attachment.content
      if (data === undefined || data === null) continue
      const stored = this.writeAttachment(Buffer.isBuffer(data) ? data : Buffer.from(data))
      insertAttachment.run(
        emailId,
        String(attachment.filename ?? 'attachment'),
        String(attachment.contentType ?? 'application/octet-stream'),
        stored.size,
        stored.hash,
        attachment.cid === undefined ? null : String(attachment.cid).replace(/^<|>$/g, ''),
        attachment.contentDisposition === undefined ? null : String(attachment.contentDisposition),
      )
    }
    try {
      db.prepare(
        `INSERT INTO emails_fts (rowid, subject, from_name, from_addr, to_addr, cc, body_text, att_filename)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        emailId,
        subject,
        String(from.name ?? ''),
        String(from.address ?? ''),
        toText,
        ccText,
        text,
        attachments
          .map((attachment) => attachment.filename)
          .filter(Boolean)
          .join(' '),
      )
    } catch {
      // Search index is best effort; the message itself is stored.
    }
    return 1
  }

  async run(options: BackupOptions = {}): Promise<BackupResult> {
    const emit = (event: BackupEvent): void => options.onEvent?.(event)
    const signal = options.signal
    const db = this.openDb()
    const startedAt = new Date().toISOString()
    const logId = Number(
      db.prepare(`INSERT INTO backup_logs (started_at, status) VALUES (?, 'running')`).run(startedAt)
        .lastInsertRowid,
    )
    const client = new ImapFlow({
      host: this.runtime.imap.host,
      port: Number(this.runtime.imap.port),
      secure: this.runtime.imap.secure !== false,
      auth: { user: this.credentials.user, pass: this.credentials.pass ?? '' },
      logger: false,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 120_000,
    })
    client.on('error', () => {})
    let newCount = 0
    let failCount = 0
    const mailboxes: { name: string; added: number }[] = []
    emit({ message: `开始备份 ${this.runtime.account.email}` })
    try {
      await client.connect()
      const boxes = await client.list()
      for (const box of boxes) {
        abortIfNeeded(signal)
        if (box.flags?.has?.('\\Noselect') === true) continue
        const path = box.path
        emit({ mailbox: path, message: `检查 ${path}` })
        const lock = await client.getMailboxLock(path)
        let boxAdded = 0
        try {
          const uidValidity = String(
            (client.mailbox as { uidValidity?: bigint | number } | undefined)?.uidValidity ?? '',
          )
          let state = db
            .prepare('SELECT uid_validity, last_uid FROM backup_state WHERE mailbox = ?')
            .get(path) as { uid_validity?: string; last_uid?: number } | undefined
          if (state === undefined) {
            const dbMax = Number(
              db.prepare('SELECT MAX(uid) AS maxUid FROM emails WHERE mailbox = ?').get(path)?.maxUid ?? 0,
            )
            this.saveState(db, path, uidValidity, dbMax)
            state = { uid_validity: uidValidity, last_uid: dbMax }
          } else if (uidValidity !== '' && String(state.uid_validity ?? '') !== uidValidity) {
            this.saveState(db, path, uidValidity, 0)
            state = { uid_validity: uidValidity, last_uid: 0 }
            emit({ mailbox: path, message: `${path} 的 UIDVALIDITY 变化，重新同步` })
          }
          const lastUid = Number(state.last_uid ?? 0)
          // Only ask the server for UIDs newer than the last committed one.
          const found = await client.search({ uid: `${String(lastUid + 1)}:*` }, { uid: true })
          const uids = (Array.isArray(found) ? found : [])
            .filter((uid) => Number(uid) > lastUid)
            .sort((left, right) => left - right)
          let committedUid = lastUid
          for (let offset = 0; offset < uids.length; offset += this.batchSize) {
            abortIfNeeded(signal)
            const batch = uids.slice(offset, offset + this.batchSize)
            db.exec('BEGIN')
            const flagEntries: { key: string; unread: boolean }[] = []
            try {
              let batchLastUid = committedUid
              for await (const message of client.fetch(
                batch.join(','),
                { uid: true, source: true, flags: true, internalDate: true },
                { uid: true },
              )) {
                abortIfNeeded(signal)
                try {
                  const parsed = await simpleParser(message.source ?? Buffer.alloc(0))
                  const added = this.insertEmail(
                    db,
                    path,
                    message as unknown as RawBackupMessage,
                    parsed,
                    logId,
                  )
                  boxAdded += added
                  newCount += added
                  batchLastUid = Math.max(batchLastUid, Number(message.uid))
                  const messageId = normalizeId(parsed.messageId ?? '')
                  if (messageId !== '') {
                    const flags = [...((message.flags ?? []) as Iterable<unknown>)].map((flag) =>
                      String(flag).toLowerCase(),
                    )
                    flagEntries.push({ key: `mid:${messageId}`, unread: !flags.includes('\\seen') })
                  }
                } catch (error) {
                  failCount += 1
                  emit({
                    mailbox: path,
                    message: `邮件 ${String(message.uid)} 解析失败: ${messageOf(error)}`,
                  })
                }
              }
              this.saveState(db, path, uidValidity, batchLastUid)
              db.exec('COMMIT')
              if (flagEntries.length > 0) this.onFlags?.(flagEntries)
              committedUid = batchLastUid
              emit({ mailbox: path, added: boxAdded, message: `${path}: 已新增 ${String(boxAdded)} 封` })
            } catch (error) {
              db.exec('ROLLBACK')
              throw error
            }
          }
          if (path.toUpperCase() === 'INBOX') await this.reconcileReadState(client)
          mailboxes.push({ name: path, added: boxAdded })
          emit({ mailbox: path, added: boxAdded, message: `${path}: 新增 ${String(boxAdded)} 封` })
        } finally {
          lock.release()
        }
      }
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM emails').get()?.n ?? 0)
      db.prepare(
        `UPDATE backup_logs SET completed_at = ?, mailboxes = ?, new_count = ?, fail_count = ?,
                total_emails = ?, status = 'completed' WHERE id = ?`,
      ).run(new Date().toISOString(), JSON.stringify(mailboxes), newCount, failCount, total, logId)
      emit({
        total,
        added: newCount,
        message: `备份完成：新增 ${String(newCount)} 封，共 ${String(total)} 封`,
      })
      return { ok: true, newCount, failCount, total, mailboxes }
    } catch (error) {
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM emails').get()?.n ?? 0)
      db.prepare(
        `UPDATE backup_logs SET completed_at = ?, mailboxes = ?, new_count = ?, fail_count = ?,
                total_emails = ?, status = 'failed', error_info = ? WHERE id = ?`,
      ).run(
        new Date().toISOString(),
        JSON.stringify(mailboxes),
        newCount,
        failCount,
        total,
        messageOf(error).slice(0, 1000),
        logId,
      )
      throw error
    } finally {
      try {
        await client.logout()
      } catch {
        // Already closed.
      }
      db.close()
    }
  }

  private saveState(db: DatabaseSync, mailbox: string, uidValidity: string, lastUid: number): void {
    db.prepare(
      `INSERT INTO backup_state (mailbox, uid_validity, last_uid, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
    ).run(mailbox, uidValidity, Number(lastUid), new Date().toISOString())
  }

  /** Latest backup summary for the settings page. */
  static status(dbFile: string): BackupStatus {
    const empty: BackupStatus = {
      running: false,
      accountId: null,
      startedAt: null,
      finishedAt: null,
      lastSuccessAt: null,
      total: 0,
      added: 0,
      message: '',
      output: [],
      exitCode: null,
    }
    if (!existsSync(dbFile)) return empty
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true })
      try {
        const latest = db.prepare('SELECT * FROM backup_logs ORDER BY id DESC LIMIT 1').get()
        const success = db
          .prepare("SELECT completed_at FROM backup_logs WHERE status = 'completed' ORDER BY id DESC LIMIT 1")
          .get()
        const total = Number(db.prepare('SELECT COUNT(*) AS n FROM emails').get()?.n ?? 0)
        return {
          ...empty,
          running: latest?.status === 'running',
          startedAt: latest?.started_at === undefined ? null : String(latest.started_at),
          finishedAt: latest?.completed_at === undefined ? null : String(latest.completed_at),
          lastSuccessAt: success?.completed_at === undefined ? null : String(success.completed_at),
          total,
          added: Number(latest?.new_count ?? 0),
          message: latest?.status === 'failed' ? String(latest?.error_info ?? '备份失败') : '',
          exitCode: latest?.status === 'failed' ? 1 : 0,
        }
      } finally {
        db.close()
      }
    } catch {
      return empty
    }
  }
}

interface RawBackupMessage {
  uid: number
  source?: Buffer
  envelope?: {
    messageId?: string
    subject?: string
    from?: { name?: string; address?: string }[]
    to?: { name?: string; address?: string }[]
    cc?: { name?: string; address?: string }[]
    date?: string | Date
  }
  internalDate?: string | Date
}

/** Format `parsed.to`/`parsed.cc`, which is an address object or a list. */
function parsedAddressText(value: unknown): string {
  if (value === undefined || value === null) return ''
  const items = Array.isArray(value) ? value : [value]
  return formatAddressList(
    items
      .map((item) => ({
        name: String((item as { name?: string }).name ?? ''),
        address: String((item as { address?: string }).address ?? ''),
      }))
      .filter((address) => address.address !== ''),
  )
}

function addressTextOf(list: unknown[] | undefined): string {
  return (list ?? [])
    .map((item) => {
      const entry = item as { name?: string; address?: string }
      return entry.name ? `${entry.name} <${String(entry.address ?? '')}>` : String(entry.address ?? '')
    })
    .filter((text) => text !== '')
    .join(', ')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { addressOf }
