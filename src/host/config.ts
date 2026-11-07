import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account, CalDavSettings, ImapSettings, NewAccountInput, SmtpSettings } from '../shared/types.js'
import { CONFIG_PATH, DATA_ROOT, accountAttachmentsDir, accountDataDir, accountMailDb } from './paths.js'

export interface AiSettings {
  enabled: boolean
  provider: string
  model: string
  styleSampleCount: number
  maxChars: number
}

export interface ReadSettings {
  markOnOpen: boolean
  pollSeconds: number
}

export interface RenderSettings {
  listLimit: number
}

export interface ProjectSettings {
  /** Default parent directory for projects created from mail. */
  root: string
}

export interface OAuthSettings {
  google: { clientId: string; redirectPort: number; scopes: string[] }
  microsoft: { clientId: string; scopes: string[] }
}

/** The resolved configuration the rest of the Host reads. */
export interface MailHarborConfig {
  dataDir: string
  configFile: string
  accounts: Account[]
  activeAccountId: string | null
  signature: string
  ai: AiSettings
  read: ReadSettings
  render: RenderSettings
  projects: ProjectSettings
  oauth: OAuthSettings
  /** Bumped whenever the file is written; caches key off this value. */
  revision: number
}

export interface AccountRuntime {
  account: Account
  root: string
  mailDb: string
  attachments: string
  keychainService: string
  imap: ImapSettings
  smtp: SmtpSettings
  auth: Account['auth']
}

const DEFAULTS = {
  signature: '',
  ai: {
    enabled: true,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    styleSampleCount: 100,
    maxChars: 40000,
  },
  read: { markOnOpen: true, pollSeconds: 60 },
  render: { listLimit: 40 },
  projects: { root: join(homedir(), 'work', 'projects') },
  oauth: {
    google: { clientId: '', redirectPort: 8765, scopes: ['https://mail.google.com/'] },
    microsoft: {
      clientId: '',
      scopes: [
        'offline_access',
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
      ],
    },
  },
} satisfies Omit<MailHarborConfig, 'dataDir' | 'configFile' | 'accounts' | 'activeAccountId' | 'revision'>

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const EMAIL = /^[^@\s]+@[^@\s]+$/

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

function hostOr(value: unknown, fallback: string): string {
  const text = stringOr(value, fallback).trim()
  return text === '' ? fallback : text
}

/** Deterministic, filesystem-safe account id derived from the address. */
export function deriveAccountId(email: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing)
  const base = `acc_${createHash('sha1').update(email.trim().toLowerCase()).digest('hex').slice(0, 8)}`
  if (!taken.has(base)) return base
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `acc_${createHash('sha1').update(`${email}:${attempt}`).digest('hex').slice(0, 8)}`
    if (!taken.has(candidate)) return candidate
  }
  return `acc_${randomUUID().slice(0, 8)}`
}

/** Validate and fill in one account record. Throws on unusable input. */
export function normalizeAccount(
  input: Partial<Account> & { email?: string },
  index = 0,
  existing: string[] = [],
): Account {
  const email = stringOr(input.email, '').trim()
  if (!EMAIL.test(email)) throw new Error('邮箱地址格式不正确')
  const id =
    typeof input.id === 'string' && ACCOUNT_ID.test(input.id)
      ? input.id
      : deriveAccountId(email, [...existing, `index:${String(index)}`])
  const domain = email.split('@')[1] ?? 'example.com'
  const username = stringOr(input.username, email).trim() || email
  return {
    id,
    label: stringOr(input.label, email).trim() || email,
    email,
    username,
    imap: {
      host: hostOr(input.imap?.host, `imap.${domain}`),
      port: intOr(input.imap?.port, 993, 1, 65535),
      secure: input.imap?.secure !== false,
    },
    smtp: {
      host: hostOr(input.smtp?.host, `smtp.${domain}`),
      port: intOr(input.smtp?.port, 465, 1, 65535),
      secure: input.smtp?.secure !== false,
      fromName: stringOr(input.smtp?.fromName, ''),
    },
    keychainService: stringOr(input.keychainService, `dsh-mailharbor:${id}`),
    dataDir: stringOr(input.dataDir, `accounts/${id}`),
    auth:
      input.auth?.type === 'oauth2'
        ? { type: 'oauth2', provider: input.auth.provider }
        : { type: 'password' },
    caldav: normalizeCaldav(input.caldav),
    enabled: input.enabled !== false,
    createdAt: stringOr(input.createdAt, new Date().toISOString()),
  }
}

function normalizeCaldav(value: CalDavSettings | null | undefined): CalDavSettings | null {
  if (value === null || value === undefined) return null
  const url = stringOr(value.url, '').trim()
  if (url === '') return null
  return {
    url,
    username: stringOr(value.username, '').trim(),
    ...(typeof value.calendarHref === 'string' && value.calendarHref !== ''
      ? { calendarHref: value.calendarHref }
      : {}),
  }
}

/** Read the config file, tolerating a missing or partly broken file. */
function readFileConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Resolve the on-disk file into the runtime configuration. */
export function loadConfig(): MailHarborConfig {
  const file = readFileConfig()
  const rawAccounts = Array.isArray(file.accounts) ? file.accounts : []
  const accounts: Account[] = []
  for (const [index, raw] of rawAccounts.entries()) {
    if (raw === null || typeof raw !== 'object') continue
    try {
      accounts.push(
        normalizeAccount(
          raw as Partial<Account>,
          index,
          accounts.map((account) => account.id),
        ),
      )
    } catch {
      // A broken record is skipped rather than breaking every other account.
    }
  }
  // Deduplicate by id; the first record wins.
  const seen = new Set<string>()
  const unique = accounts.filter((account) => {
    if (seen.has(account.id)) return false
    seen.add(account.id)
    return true
  })
  const requested = stringOr(file.activeAccountId, '')
  const activeAccountId = unique.some((account) => account.id === requested)
    ? requested
    : (unique.find((account) => account.enabled !== false)?.id ?? null)
  const aiRaw = (file.ai ?? {}) as Record<string, unknown>
  const readRaw = (file.read ?? {}) as Record<string, unknown>
  const renderRaw = (file.render ?? {}) as Record<string, unknown>
  const projectsRaw = (file.projects ?? {}) as Record<string, unknown>
  const oauthRaw = (file.oauth ?? {}) as Record<string, unknown>
  const googleRaw = (oauthRaw.google ?? {}) as Record<string, unknown>
  const microsoftRaw = (oauthRaw.microsoft ?? {}) as Record<string, unknown>
  return {
    dataDir: DATA_ROOT,
    configFile: CONFIG_PATH,
    accounts: unique,
    activeAccountId,
    signature: stringOr(file.signature, DEFAULTS.signature),
    ai: {
      enabled: aiRaw.enabled !== false,
      provider: stringOr(aiRaw.provider, DEFAULTS.ai.provider),
      model: stringOr(aiRaw.model, DEFAULTS.ai.model),
      styleSampleCount: intOr(aiRaw.styleSampleCount, DEFAULTS.ai.styleSampleCount, 10, 200),
      maxChars: intOr(aiRaw.maxChars, DEFAULTS.ai.maxChars, 1000, 200000),
    },
    read: {
      markOnOpen: readRaw.markOnOpen !== false,
      pollSeconds: intOr(readRaw.pollSeconds, DEFAULTS.read.pollSeconds, 15, 3600),
    },
    render: {
      listLimit: intOr(renderRaw.listLimit, DEFAULTS.render.listLimit, 10, 200),
    },
    projects: {
      root: stringOr(projectsRaw.root, DEFAULTS.projects.root),
    },
    oauth: {
      google: {
        clientId: stringOr(googleRaw.clientId, DEFAULTS.oauth.google.clientId),
        redirectPort: intOr(googleRaw.redirectPort, DEFAULTS.oauth.google.redirectPort, 1024, 65535),
        scopes: Array.isArray(googleRaw.scopes)
          ? googleRaw.scopes.filter((item): item is string => typeof item === 'string')
          : DEFAULTS.oauth.google.scopes,
      },
      microsoft: {
        clientId: stringOr(microsoftRaw.clientId, DEFAULTS.oauth.microsoft.clientId),
        scopes: Array.isArray(microsoftRaw.scopes)
          ? microsoftRaw.scopes.filter((item): item is string => typeof item === 'string')
          : DEFAULTS.oauth.microsoft.scopes,
      },
    },
    revision: Date.now(),
  }
}

/** Merge `patch` into the config file atomically and return the merged file. */
export function writeConfigFile(patch: Record<string, unknown>): Record<string, unknown> {
  const current = readFileConfig()
  const next = { ...current, ...patch }
  if (current.accounts !== undefined || patch.accounts !== undefined) {
    next.accounts = patch.accounts ?? current.accounts
  }
  mkdirSync(DATA_ROOT, { recursive: true })
  const temp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, CONFIG_PATH)
  return next
}

/** Persist the mutable settings the client may change. */
export function saveSettings(patch: {
  signature?: string
  ai?: Partial<AiSettings>
  read?: Partial<ReadSettings>
  render?: Partial<RenderSettings>
}): void {
  writeConfigFile(patch as Record<string, unknown>)
}

/** Persist the full account list and the active account. */
export function saveAccounts(accounts: Account[], activeAccountId: string | null): void {
  writeConfigFile({ accounts, activeAccountId })
}

/** Build a new account record from client input. */
export function buildAccount(input: NewAccountInput, existing: Account[]): Account {
  const email = input.email.trim()
  if (!EMAIL.test(email)) throw new Error('邮箱地址格式不正确')
  const id = deriveAccountId(
    email,
    existing.map((account) => account.id),
  )
  return normalizeAccount(
    {
      id,
      email,
      label: input.label,
      username: input.username,
      imap: input.imap as ImapSettings | undefined,
      smtp: input.smtp as SmtpSettings | undefined,
      auth: { type: 'password' },
      caldav: null,
      enabled: true,
      createdAt: new Date().toISOString(),
    },
    0,
    existing.map((account) => account.id),
  )
}

/** Per-account runtime paths and connection settings. */
export function accountRuntime(account: Account): AccountRuntime {
  const root = accountDataDir(account)
  return {
    account,
    root,
    mailDb: accountMailDb(account),
    attachments: accountAttachmentsDir(account),
    keychainService: account.keychainService || `dsh-mailharbor:${account.id}`,
    imap: account.imap,
    smtp: account.smtp,
    auth: account.auth,
  }
}

/** Find an account by id, or throw a user-facing error. */
export function requireAccount(config: MailHarborConfig, id: string | null | undefined): Account {
  const account =
    config.accounts.find((item) => item.id === id) ??
    config.accounts.find((item) => item.id === config.activeAccountId)
  if (account === undefined) throw new Error('请先添加一个邮箱账号')
  return account
}

/** The active account, or null when no account exists yet. */
export function activeAccount(config: MailHarborConfig): Account | null {
  return config.accounts.find((account) => account.id === config.activeAccountId) ?? null
}

/** Directory used for one account's attachments. */
export function attachmentsRoot(account: Account): string {
  return join(accountDataDir(account), 'attachments')
}
