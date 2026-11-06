import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { Address, AttachmentMeta, ImapSettings } from '../shared/types.js'
import { addressOf, formatAddressList, parseAddressList } from './address.js'

export interface ImapCredentials {
  user: string
  pass?: string
  accessToken?: string
}

export interface ImapMessage {
  uid: number
  messageId: string
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  date: string
  size: number
  flags: string[]
  read: boolean
}

export interface ImapMailbox {
  path: string
  name: string
  specialUse: string | null
  messages: number
}

export interface ImapFullMessage extends ImapMessage {
  text: string
  html: string | null
  attachments: AttachmentMeta[]
  inReplyTo: string
  references: string[]
}

export interface ImapProviderOptions {
  connectionTimeoutMs?: number
  socketTimeoutMs?: number
  /** Called whenever the connection is replaced, for logging. */
  onReconnect?: (reason: string) => void
}

function normalizeId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .trim()
}

function isoDate(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : value === undefined || value === null
        ? undefined
        : new Date(String(value))
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
}

function flagsOf(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return [...(value as Iterable<unknown>)].map((flag) => String(flag))
}

function isSeen(flags: string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === '\\seen')
}

function attachmentList(parsed: Awaited<ReturnType<typeof simpleParser>>): AttachmentMeta[] {
  return (parsed.attachments ?? []).map((attachment, index) => ({
    id: String(index),
    filename: String(attachment.filename ?? 'attachment'),
    contentType: String(attachment.contentType ?? 'application/octet-stream'),
    size: Number(attachment.size ?? attachment.content?.length ?? 0),
  }))
}

/**
 * One IMAP account. The connection is reused across operations and every
 * operation is serialized, because an IMAP session is stateful: two interleaved
 * commands on one socket corrupt each other. A failed connection is discarded
 * and rebuilt on the next call, so a dropped socket never wedges the account.
 */
export class ImapProvider {
  private readonly settings: ImapSettings
  private readonly credentials: ImapCredentials
  private readonly options: ImapProviderOptions
  private client: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(settings: ImapSettings, credentials: ImapCredentials, options: ImapProviderOptions = {}) {
    this.settings = settings
    this.credentials = credentials
    this.options = options
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client !== null && this.client.usable) return this.client
    if (this.connecting !== null) return this.connecting
    this.connecting = (async () => {
      const client = new ImapFlow({
        host: this.settings.host,
        port: Number(this.settings.port),
        secure: this.settings.secure !== false,
        auth:
          this.credentials.accessToken !== undefined
            ? { user: this.credentials.user, accessToken: this.credentials.accessToken }
            : { user: this.credentials.user, pass: this.credentials.pass ?? '' },
        logger: false,
        tls: { rejectUnauthorized: true },
        connectionTimeout: this.options.connectionTimeoutMs ?? 15_000,
        greetingTimeout: this.options.connectionTimeoutMs ?? 15_000,
        socketTimeout: this.options.socketTimeoutMs ?? 60_000,
      })
      client.on('error', () => {
        // Errors surface through the operation that triggered them; keep the
        // process-wide handler so an idle socket error is never unhandled.
      })
      client.on('close', () => {
        if (this.client === client) this.client = null
      })
      try {
        await client.connect()
      } catch (error) {
        throw new Error(
          `IMAP 连接失败 (${this.settings.host}:${String(this.settings.port)}): ${messageOf(error)}`,
        )
      }
      this.client = client
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async reset(reason: string): Promise<void> {
    const client = this.client
    this.client = null
    if (client !== null) {
      try {
        await client.logout()
      } catch {
        // Already gone.
      }
    }
    if (!this.disposed) this.options.onReconnect?.(reason)
  }

  /** Serialize one operation on this account's connection. */
  private run<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const task = this.queue.then(
      async () => {
        const client = await this.connect()
        try {
          return await operation(client)
        } catch (error) {
          // A protocol or socket failure invalidates the session; reconnect next time.
          if (isFatal(error)) await this.reset(messageOf(error))
          throw error
        }
      },
      async () => {
        const client = await this.connect()
        return operation(client)
      },
    )
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async check(): Promise<{ ok: true; mailboxes: { name: string; count: number }[] }> {
    return this.run(async (client) => {
      const boxes = await this.listMailboxes(client)
      return { ok: true as const, mailboxes: boxes.map((box) => ({ name: box.path, count: box.messages })) }
    })
  }

  async mailboxes(): Promise<ImapMailbox[]> {
    return this.run((client) => this.listMailboxes(client))
  }

  private async listMailboxes(client: ImapFlow): Promise<ImapMailbox[]> {
    const listed = await client.list()
    const result: ImapMailbox[] = []
    for (const box of listed) {
      if (box.flags?.has?.('\\Noselect') === true) continue
      let messages = 0
      try {
        const status = await client.status(box.path, { messages: true })
        if (status !== false) messages = Number(status.messages ?? 0)
      } catch {
        // Some servers refuse STATUS on the selected mailbox; the count is optional.
      }
      result.push({
        path: box.path,
        name: box.name ?? box.path,
        specialUse: box.specialUse ?? null,
        messages,
      })
    }
    return result
  }

  async list(mailbox: string, limit: number, offset = 0): Promise<{ total: number; items: ImapMessage[] }> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const total = Number((client.mailbox as { exists?: number } | undefined)?.exists ?? 0)
        const end = total - offset
        if (total === 0 || end < 1) return { total, items: [] }
        const start = Math.max(1, end - limit + 1)
        const items: ImapMessage[] = []
        for await (const message of client.fetch(`${String(start)}:${String(end)}`, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        })) {
          items.push(toMessage(message as unknown as RawImapMessage))
        }
        items.sort((left, right) => right.date.localeCompare(left.date))
        return { total, items }
      } finally {
        lock.release()
      }
    })
  }

  async read(mailbox: string, uid: number): Promise<ImapFullMessage> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const message = await client.fetchOne(
          uid,
          { uid: true, source: true, flags: true, envelope: true, internalDate: true, size: true },
          { uid: true },
        )
        if (message === false || message === undefined || message.source === undefined) {
          throw new Error('邮件不存在')
        }
        const parsed = await simpleParser(message.source)
        const base = toMessage(message as unknown as RawImapMessage)
        const html =
          typeof parsed.html === 'string'
            ? parsed.html
            : Buffer.isBuffer(parsed.html)
              ? parsed.html.toString('utf8')
              : null
        return {
          ...base,
          text: typeof parsed.text === 'string' ? parsed.text : '',
          html: html === '' ? null : html,
          attachments: attachmentList(parsed),
          inReplyTo: normalizeId(parsed.inReplyTo),
          references: String(parsed.references ?? '')
            .split(/\s+/)
            .map(normalizeId)
            .filter((item) => item !== ''),
        }
      } finally {
        lock.release()
      }
    })
  }

  async attachment(
    mailbox: string,
    uid: number,
    part: number,
  ): Promise<{ filename: string; contentType: string; dataBase64: string }> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const message = await client.fetchOne(uid, { uid: true, source: true }, { uid: true })
        if (message === false || message === undefined || message.source === undefined) {
          throw new Error('邮件不存在')
        }
        const parsed = await simpleParser(message.source)
        const attachment = parsed.attachments?.[part]
        if (attachment === undefined) throw new Error('附件不存在')
        return {
          filename: String(attachment.filename ?? 'attachment'),
          contentType: String(attachment.contentType ?? 'application/octet-stream'),
          dataBase64: attachment.content.toString('base64'),
        }
      } finally {
        lock.release()
      }
    })
  }

  async unseen(): Promise<{ count: number; items: { uid: number; messageId: string }[] }> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock('INBOX')
      try {
        const found = await client.search({ seen: false }, { uid: true })
        const uids = Array.isArray(found) ? found : []
        const items: { uid: number; messageId: string }[] = []
        if (uids.length > 0) {
          const range = uids.slice(-200).join(',')
          for await (const message of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
            items.push({
              uid: Number(message.uid),
              messageId: normalizeId(message.envelope?.messageId),
            })
          }
        }
        return { count: uids.length, items }
      } finally {
        lock.release()
      }
    })
  }

  async setSeen(mailbox: string, uid: number, seen: boolean): Promise<{ read: boolean; flags: string[] }> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        if (seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
        const message = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true })
        const flags = flagsOf(message === false || message === undefined ? [] : message.flags)
        return { read: isSeen(flags), flags }
      } finally {
        lock.release()
      }
    })
  }

  /** Set \Seen by Message-ID, which is how local-archive rows reach the server. */
  async setSeenByMessageId(
    mailbox: string,
    messageId: string,
    seen: boolean,
  ): Promise<{ found: boolean; uid?: number; read?: boolean }> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const id = normalizeId(messageId)
        let found = await client.search({ header: { 'Message-ID': id } }, { uid: true })
        if (!Array.isArray(found) || found.length === 0) {
          found = await client.search({ header: { 'Message-ID': `<${id}>` } }, { uid: true })
        }
        const uids = Array.isArray(found) ? found : []
        const uid = uids[uids.length - 1]
        if (uid === undefined) return { found: false }
        if (seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
        const message = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true })
        const flags = flagsOf(message === false || message === undefined ? [] : message.flags)
        return { found: true, uid: Number(uid), read: isSeen(flags) }
      } finally {
        lock.release()
      }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.reset('dispose')
  }
}

export interface RawImapMessage {
  uid: number
  envelope?: {
    messageId?: string
    subject?: string
    from?: { name?: string; address?: string }[]
    to?: { name?: string; address?: string }[]
    cc?: { name?: string; address?: string }[]
    date?: string | Date
  }
  internalDate?: string | Date
  size?: number
  flags?: Iterable<unknown>
}

function toMessage(message: RawImapMessage): ImapMessage {
  const flags = flagsOf(message.flags)
  const addressList = (value: { name?: string; address?: string }[] | undefined): Address[] =>
    (value ?? [])
      .map((entry) => ({ name: entry.name ?? '', address: entry.address ?? '' }))
      .filter((address) => address.address !== '')
  return {
    uid: Number(message.uid),
    messageId: normalizeId(message.envelope?.messageId),
    subject: String(message.envelope?.subject ?? '(无主题)'),
    from: addressList(message.envelope?.from)[0] ?? { name: '', address: '' },
    to: addressList(message.envelope?.to),
    cc: addressList(message.envelope?.cc),
    date: isoDate(message.internalDate ?? message.envelope?.date),
    size: Number(message.size ?? 0),
    flags,
    read: isSeen(flags),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Errors that mean the session itself is unusable. */
function isFatal(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code ?? ''
    if (
      /^(NoConnection|ConnectionClosed|ConnectionNotAvailable|EConnectionClosed|ETIMEDOUT|ECONNRESET|EPIPE)$/.test(
        code,
      )
    ) {
      return true
    }
    return /connection (closed|lost|not available)|socket/i.test(error.message)
  }
  return false
}

/** Exported for tests and for the service layer that formats addresses. */
export { addressOf, formatAddressList, parseAddressList }
