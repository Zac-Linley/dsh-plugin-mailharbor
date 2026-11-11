import type { OAuthProvider } from '../shared/types.js'

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  scope?: string
  tokenType?: string
}

export interface OAuthApp {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  redirectPort: number
  scopes: string[]
}

const TOKEN_ENDPOINTS: Record<OAuthProvider, string> = {
  google: 'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
}

const DEVICE_ENDPOINTS: Record<OAuthProvider, string> = {
  google: 'https://oauth2.googleapis.com/device/code',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
}

export function tokenEndpoint(provider: OAuthProvider): string {
  return TOKEN_ENDPOINTS[provider]
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString()
}

function tokensFrom(payload: Record<string, unknown>, previousRefresh = ''): OAuthTokenSet {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (accessToken === '') throw new Error('OAuth 响应缺少 access_token')
  const refreshToken =
    typeof payload.refresh_token === 'string' && payload.refresh_token !== ''
      ? payload.refresh_token
      : previousRefresh
  const expiresIn = Number(payload.expires_in ?? 3600)
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
    ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
  }
}

export async function refreshTokens(app: OAuthApp, refreshToken: string): Promise<OAuthTokenSet> {
  if (refreshToken === '') throw new Error('OAuth 刷新令牌为空')
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: app.clientId,
    refresh_token: refreshToken,
  }
  if (app.provider === 'google') body.client_secret = app.clientSecret
  const response = await fetch(TOKEN_ENDPOINTS[app.provider], {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(body),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const reason =
      typeof payload.error_description === 'string'
        ? payload.error_description
        : typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${String(response.status)}`
    throw new Error(`OAuth 刷新失败：${reason}`)
  }
  return tokensFrom(payload, refreshToken)
}

export function googleAuthUrl(app: OAuthApp, state: string, challenge: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: app.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export async function exchangeGoogleCode(
  app: OAuthApp,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokenSet> {
  const response = await fetch(TOKEN_ENDPOINTS.google, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(
      `OAuth 授权失败：${typeof payload.error_description === 'string' ? payload.error_description : `HTTP ${String(response.status)}`}`,
    )
  }
  return tokensFrom(payload)
}

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresAt: number
}

export async function startDeviceFlow(app: OAuthApp): Promise<DeviceFlowStart> {
  const body: Record<string, string> = {
    client_id: app.clientId,
    scope: app.scopes.join(' '),
  }
  if (app.provider === 'microsoft') body.scope = [...app.scopes, 'offline_access'].join(' ')
  const response = await fetch(DEVICE_ENDPOINTS[app.provider], {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(body),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(
      `OAuth 设备码请求失败：${typeof payload.error_description === 'string' ? payload.error_description : `HTTP ${String(response.status)}`}`,
    )
  }
  return {
    deviceCode: String(payload.device_code ?? ''),
    userCode: String(payload.user_code ?? ''),
    verificationUri: String(payload.verification_uri ?? payload.verification_url ?? ''),
    interval: Math.max(2, Number(payload.interval ?? 5)),
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 900)) * 1000,
  }
}

export async function pollDeviceFlow(
  app: OAuthApp,
  deviceCode: string,
): Promise<{ status: 'pending' } | { status: 'ready'; tokens: OAuthTokenSet }> {
  const response = await fetch(TOKEN_ENDPOINTS[app.provider], {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: app.clientId,
      device_code: deviceCode,
    }),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (response.ok) return { status: 'ready', tokens: tokensFrom(payload) }
  const error = String(payload.error ?? '')
  if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' }
  throw new Error(
    `OAuth 设备码登录失败：${typeof payload.error_description === 'string' ? payload.error_description : error}`,
  )
}
