/**
 * Wire types shared by the Host half and the browser half.
 *
 * The HTTP API under `/mail-plugin/api` and the `mail_*` agent tools both speak
 * these shapes. Keep them JSON-serializable: no Date objects, no Buffers.
 */

export const VERSION = '0.1.0'

/**
 * Mailbox buckets the UI can browse: an IMAP path as stored by the backup
 * engine, or `all` for the unified list.
 */
export type Mailbox = string

export const MAILBOX_ALL = 'all'

/** Where a list or a message comes from. */
export type Source = 'local' | 'server'

/** Sort order accepted by message lists. */
export type SortOrder = 'newest' | 'oldest'

export interface ImapSettings {
  host: string
  port: number
  secure: boolean
}

export interface SmtpSettings extends ImapSettings {
  fromName: string
}

export interface Address {
  name: string
  address: string
}

export type OAuthProvider = 'google' | 'microsoft'

export interface OAuthAccountAuth {
  type: 'oauth2'
  provider: OAuthProvider
}

export interface PasswordAccountAuth {
  type: 'password'
}

export interface CalDavSettings {
  url: string
  username: string
  /** Calendar collection href discovered from the principal, when known. */
  calendarHref?: string
}

export interface Account {
  id: string
  label: string
  email: string
  username: string
  imap: ImapSettings
  smtp: SmtpSettings
  /** Keychain service that stores this account's password. */
  keychainService: string
  /** Path relative to the data root, e.g. `accounts/acc_ab12`. */
  dataDir: string
  auth: PasswordAccountAuth | OAuthAccountAuth
  caldav: CalDavSettings | null
  enabled: boolean
  createdAt: string
}

/**
 * Account fields a client may submit when adding an account. Secrets are never
 * part of the account record; they are passed separately and stored by the
 * credential backend.
 */
export interface NewAccountInput {
  email: string
  label?: string
  username?: string
  password?: string
  imap?: Partial<ImapSettings>
  smtp?: Partial<SmtpSettings>
  /** Keep the password in the OS credential store instead of this session only. */
  remember?: boolean
}

export interface AttachmentMeta {
  /** Stable local identifier (content hash) or IMAP part id. */
  id: string
  filename: string
  contentType: string
  size: number
}

export interface MessageSummary {
  /** Local rowid (local source) or IMAP uid (server source), as a string. */
  id: string
  accountId: string
  /** Server UID when known; enables marking read and fetching attachments. */
  uid?: number
  messageId?: string
  subject: string
  from: Address
  to: Address[]
  date: string
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  snippet: string
  size?: number
  mailbox: Mailbox
  /** Server rows only: whether the local backup already holds this message. */
  backedUp?: boolean
}

export interface MessageDetail extends MessageSummary {
  cc: Address[]
  replyTo: Address[]
  text: string
  /** Raw HTML body as stored; the client sanitizes and sandboxes it. */
  html: string | null
  attachments: AttachmentMeta[]
  inReplyTo?: string
  references: string[]
}

export interface DraftInput {
  to: string
  cc: string
  bcc: string
  subject: string
  /** Sanitized HTML body. */
  html: string
  attachments: DraftAttachment[]
  inReplyTo?: string
  references?: string
}

export interface DraftAttachment {
  filename: string
  contentType: string
  /** Base64 payload for client-supplied drafts. */
  data: string
}

export interface Draft extends DraftInput {
  id: string
  accountId: string
  updatedAt: string
}

export interface OutgoingAttachment {
  filename: string
  contentType: string
  content: Buffer | string
}

export interface SendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

export interface BackupStatus {
  running: boolean
  accountId: string | null
  startedAt: string | null
  finishedAt: string | null
  lastSuccessAt: string | null
  total: number
  added: number
  message: string
  output: string[]
  exitCode: number | null
}

export interface SettingsView {
  dataDir: string
  configFile: string
  signature: string
  accounts: Account[]
  activeAccountId: string | null
  ai: {
    enabled: boolean
    provider: string
    model: string
    styleSampleCount: number
  }
  read: {
    markOnOpen: boolean
    pollSeconds: number
  }
  render: {
    listLimit: number
  }
  projects: {
    root: string
  }
}

export interface AppState {
  version: string
  settings: SettingsView
  accounts: Account[]
  activeAccountId: string | null
  backup: BackupStatus
  unread: number
  loggedIn: boolean
}

export interface Page<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

/** One AI output, kept in a per-mail thread. */
export type AiCardKind = 'summary' | 'reply' | 'translate' | 'answer' | 'compose'

export interface AiCardMeta {
  to?: string
  subject?: string
  inReplyTo?: string
  references?: string
  /** Translation target or reply language. */
  target?: 'zh' | 'en'
  language?: 'zh' | 'en'
}

export interface AiCard {
  id: string
  kind: AiCardKind
  instruction: string
  output: string
  html?: string
  meta?: AiCardMeta
  provider: string
  model: string
  createdAt: string
}

export interface AiThread {
  /** `mid:<message-id>` when known, else `<source>:<id>`. */
  key: string
  accountId: string
  subject: string
  messageId?: string
  cards: AiCard[]
  updatedAt: string
}

export interface Task {
  id: string
  accountId: string
  projectId: string | null
  title: string
  notes: string
  due: string
  status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED'
  priority: number
  owner: string
  messageKey: string
  messageSubject: string
  dirty: boolean
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ProjectMessageLink {
  accountId: string
  key: string
  subject: string
  date: string
}

export interface Project {
  id: string
  name: string
  path: string
  workspaceId: string
  sessionId: string
  accountIds: string[]
  messages: ProjectMessageLink[]
  threads: { accountId: string; key: string }[]
  createdAt: string
  updatedAt: string
}

export interface TaskSuggestion {
  title: string
  due: string
  priority: number
  owner: string
  notes: string
}

export interface AiSearchFilters {
  keywords: string[]
  from: string
  subject: string
  since: string
  before: string
  explanation: string
}

export interface ApiError {
  error: string
  code?: string
}
