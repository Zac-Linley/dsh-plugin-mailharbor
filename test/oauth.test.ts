import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollDeviceFlow, refreshTokens, type OAuthApp } from '../src/host/oauth.js'

const google: OAuthApp = {
  provider: 'google',
  clientId: 'client',
  clientSecret: 'secret',
  redirectPort: 8765,
  scopes: ['https://mail.google.com/'],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OAuth helpers', () => {
  it('refreshes a Google token and keeps the old refresh token', async () => {
    const fetch = vi.fn(async () => jsonResponse({ access_token: 'new', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetch)
    const tokens = await refreshTokens(google, 'refresh')
    expect(tokens.accessToken).toBe('new')
    expect(tokens.refreshToken).toBe('refresh')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    const body = String(calls[0]?.[1].body ?? '')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('client_secret=secret')
  })

  it('reports pending device authorization and then ready', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetch)
    const app: OAuthApp = { ...google, provider: 'microsoft', clientSecret: '' }
    await expect(pollDeviceFlow(app, 'code')).resolves.toEqual({ status: 'pending' })
    const ready = await pollDeviceFlow(app, 'code')
    expect(ready.status).toBe('ready')
    if (ready.status === 'ready') expect(ready.tokens.refreshToken).toBe('r')
  })
})
