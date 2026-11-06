import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * One data root per OS user. It lives beside the DSH home so the plugin behaves
 * the same on macOS, Windows and Linux. `DSH_MAILHARBOR_DATA_DIR` moves it.
 */
export const DATA_ROOT = process.env.DSH_MAILHARBOR_DATA_DIR ?? join(homedir(), '.dsh', 'mailharbor')

/** Plugin state (config, drafts, read state, logs). */
export const CONFIG_PATH = process.env.DSH_MAILHARBOR_CONFIG ?? join(DATA_ROOT, 'config.json')

export const ACCOUNTS_DIR = join(DATA_ROOT, 'accounts')
export const STATE_DIR = join(DATA_ROOT, 'state')
export const REPORTS_DIR = join(DATA_ROOT, 'reports')
export const LOGS_DIR = join(DATA_ROOT, 'logs')

/** Resolve `~`, reject relative paths, and normalize separators. */
export function resolveUserPath(value: string, label: string): string {
  const text = value.trim()
  if (text === '') throw new Error(`${label}不能为空`)
  if (text.length > 4096) throw new Error(`${label}过长`)
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text
  if (!isAbsolute(expanded)) throw new Error(`${label}必须是绝对路径`)
  return expanded
}

/** Account directory names stay portable; IDs are validated by the config layer. */
export function accountRoot(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
  return join(ACCOUNTS_DIR, safe)
}

/** Absolute directory for an account record's data. */
export function accountDataDir(account: { id: string; dataDir?: string | null }): string {
  const configured = typeof account.dataDir === 'string' ? account.dataDir.trim() : ''
  if (configured === '') return accountRoot(account.id)
  return isAbsolute(configured) ? configured : join(DATA_ROOT, configured)
}

export function accountMailDb(account: { id: string; dataDir?: string | null }): string {
  return join(accountDataDir(account), 'mail.db')
}

export function accountAttachmentsDir(account: { id: string; dataDir?: string | null }): string {
  return join(accountDataDir(account), 'attachments')
}
