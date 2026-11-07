import type { Account } from '../shared/types.js'
import { SecretStore } from './secrets.js'

export type PasswordSource = 'session' | 'env' | 'keychain'

export interface ResolvedPassword {
  password: string
  source: PasswordSource
}

export interface CredentialStatus {
  hasPassword: boolean
  source: PasswordSource | null
  provider: string
}

function envKeyFor(account: Account): string {
  const suffix = account.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return `DSH_MAILHARBOR_PASSWORD_${suffix}`
}

/**
 * Account passwords live in three places, in priority order: this process's
 * session (a fresh login), the environment (CI and scripted installs), and the
 * OS credential store. They are never written to `config.json`.
 */
export class CredentialManager {
  private readonly session = new Map<string, string>()
  private readonly secrets: SecretStore

  constructor(secrets: SecretStore = new SecretStore()) {
    this.secrets = secrets
  }

  get provider(): string {
    return this.secrets.provider
  }

  resolve(account: Account): ResolvedPassword | undefined {
    const session = this.session.get(account.id)
    if (session !== undefined && session !== '') return { password: session, source: 'session' }
    const fromEnv = process.env[envKeyFor(account)]
    if (typeof fromEnv === 'string' && fromEnv !== '') return { password: fromEnv, source: 'env' }
    const stored = this.secrets.read(account.keychainService, account.email)
    if (stored !== undefined) return { password: stored, source: 'keychain' }
    return undefined
  }

  /** Keep the password for this run and, when asked, for later runs. */
  remember(account: Account, password: string, persist: boolean): { stored: boolean } {
    if (password === '') throw new Error('密码不能为空')
    this.session.set(account.id, password)
    if (!persist) return { stored: false }
    return { stored: this.secrets.write(account.keychainService, account.email, password) }
  }

  forget(account: Account): void {
    this.session.delete(account.id)
    this.secrets.delete(account.keychainService, account.email)
  }

  /** Read an arbitrary secret (for example a CalDAV app password). */
  readSecret(service: string, account: string): string | undefined {
    return this.secrets.read(service, account)
  }

  writeSecret(service: string, account: string, secret: string): boolean {
    return this.secrets.write(service, account, secret)
  }

  deleteSecret(service: string, account: string): boolean {
    return this.secrets.delete(service, account)
  }

  status(account: Account): CredentialStatus {
    const resolved = this.resolve(account)
    return {
      hasPassword: resolved !== undefined,
      source: resolved?.source ?? null,
      provider: this.secrets.provider,
    }
  }
}
