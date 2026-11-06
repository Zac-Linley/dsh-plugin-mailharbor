import { describe, expect, it } from 'vitest'
import { deriveAccountId, buildAccount, normalizeAccount } from '../src/host/config.js'

describe('account normalization', () => {
  it('fills sensible defaults from the address', () => {
    const account = normalizeAccount({ email: 'user@example.com' })
    expect(account.id).toMatch(/^acc_[0-9a-f]{8}$/)
    expect(account.imap).toEqual({ host: 'imap.example.com', port: 993, secure: true })
    expect(account.smtp).toEqual({ host: 'smtp.example.com', port: 465, secure: true, fromName: '' })
    expect(account.keychainService).toBe(`dsh-mailharbor:${account.id}`)
    expect(account.dataDir).toBe(`accounts/${account.id}`)
  })

  it('keeps explicit server settings and flags', () => {
    const account = normalizeAccount({
      email: 'user@corp.test',
      label: 'Work',
      username: 'corp\\user',
      imap: { host: 'mail.corp.test', port: 143, secure: false },
      smtp: { host: 'mail.corp.test', port: 587, secure: false, fromName: 'Zac' },
    })
    expect(account.label).toBe('Work')
    expect(account.username).toBe('corp\\user')
    expect(account.imap).toEqual({ host: 'mail.corp.test', port: 143, secure: false })
    expect(account.smtp.port).toBe(587)
    expect(account.smtp.fromName).toBe('Zac')
  })

  it('rejects an invalid address', () => {
    expect(() => normalizeAccount({ email: 'not-an-address' })).toThrow('邮箱地址格式不正确')
    expect(() => normalizeAccount({ email: '' })).toThrow()
  })

  it('derives stable ids and avoids collisions', () => {
    const first = deriveAccountId('a@example.com')
    expect(deriveAccountId('a@example.com')).toBe(first)
    expect(deriveAccountId('a@example.com', [first])).not.toBe(first)
  })

  it('builds a new account without touching existing ids', () => {
    const existing = [normalizeAccount({ email: 'b@example.com' })]
    const account = buildAccount({ email: 'a@example.com' }, existing)
    expect(account.id).not.toBe(existing[0]?.id)
    expect(account.auth).toEqual({ type: 'password' })
  })

  it('normalizes CalDAV settings and drops empty ones', () => {
    expect(normalizeAccount({ email: 'a@example.com', caldav: null }).caldav).toBeNull()
    expect(
      normalizeAccount({
        email: 'a@example.com',
        caldav: { url: 'https://cal.example.com', username: 'me' },
      }).caldav,
    ).toEqual({ url: 'https://cal.example.com', username: 'me' })
  })
})
