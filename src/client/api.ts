import type {
  Account,
  AppState,
  AttachmentMeta,
  BackupStatus,
  Draft,
  MessageDetail,
  MessageSummary,
  NewAccountInput,
  Page,
  SendResult,
  SettingsView,
} from '../shared/types.js'

/** Same-origin API root: works in the Web GUI and through the desktop shell. */
const BASE = new URL('mail-plugin/api/', document.baseURI).href

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, BASE), {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body: unknown = await response.json()
      if (
        body !== null &&
        typeof body === 'object' &&
        typeof (body as { error?: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error
      }
    } catch {
      // Keep the status text.
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export interface ListParams {
  accountId?: string | null
  source: 'local' | 'server'
  mailbox: string
  query?: string
  offset?: number
  limit?: number
}

export const api = {
  state: (): Promise<AppState> => request<AppState>('state'),

  folders: (params: { accountId?: string | null; source: 'local' | 'server' }) =>
    request<{ items: { name: string; label?: string; count: number }[] }>(`folders${query(params)}`),

  messages: (params: ListParams) => request<Page<MessageSummary>>(`messages${query({ ...params })}`),

  message: (params: { id: string; accountId?: string | null; source: 'local' | 'server'; mailbox: string }) =>
    request<MessageDetail>(`messages/${encodeURIComponent(params.id)}${query({ ...params })}`),

  setRead: (params: {
    id: string
    accountId?: string | null
    source: 'local' | 'server'
    mailbox: string
    read: boolean
  }) =>
    request<{ ok: true; read: boolean }>(
      `messages/${encodeURIComponent(params.id)}/read${query({
        accountId: params.accountId ?? null,
        source: params.source,
        mailbox: params.mailbox,
      })}`,
      { method: 'POST', body: JSON.stringify({ read: params.read }) },
    ),

  attachmentUrl: (params: Record<string, string | number | undefined | null>) =>
    new URL(`attachment${query(params)}`, BASE).href,

  drafts: (accountId?: string | null) =>
    request<{ items: Draft[] }>(`drafts${query({ accountId: accountId ?? null })}`),

  saveDraft: (accountId: string | null, draft: Partial<Draft>) =>
    request<{ draft: Draft }>(`drafts${query({ accountId: accountId ?? null })}`, {
      method: 'POST',
      body: JSON.stringify(draft),
    }),

  deleteDraft: (id: string, accountId?: string | null) =>
    request<{ ok: true }>(`drafts/${encodeURIComponent(id)}${query({ accountId: accountId ?? null })}`, {
      method: 'DELETE',
    }),

  send: (accountId: string | null, payload: Record<string, unknown>) =>
    request<{ ok: true; result: SendResult }>(`send${query({ accountId: accountId ?? null })}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  unread: (accountId?: string | null) =>
    request<{ unread: number; source: string }>(`unread${query({ accountId: accountId ?? null })}`),

  addAccount: (input: NewAccountInput & { connect?: boolean; remember?: boolean }) =>
    request<{ account: Account; state: AppState }>('accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateAccount: (id: string, patch: Record<string, unknown>) =>
    request<{ account: Account }>(`accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteAccount: (id: string) =>
    request<{ ok: true }>(`accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  activateAccount: (id: string) =>
    request<{ ok: true }>(`accounts/${encodeURIComponent(id)}/activate`, { method: 'POST' }),

  login: (id: string, password: string, remember: boolean) =>
    request<{ ok: true; stored: boolean }>(`accounts/${encodeURIComponent(id)}/login`, {
      method: 'POST',
      body: JSON.stringify({ password, remember }),
    }),

  logout: (id: string) =>
    request<{ ok: true }>(`accounts/${encodeURIComponent(id)}/logout`, { method: 'POST' }),

  check: (id: string) =>
    request<{
      ok: true
      imap: { ok: true; mailboxes: { name: string; count: number }[] }
      smtp: { ok: boolean; error?: string }
    }>(`accounts/${encodeURIComponent(id)}/check`, { method: 'POST' }),

  settings: () => request<SettingsView>('settings'),

  saveSettings: (patch: Record<string, unknown>) =>
    request<{ settings: SettingsView }>('settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  backupStatus: (accountId?: string | null) =>
    request<BackupStatus>(`backup/status${query({ accountId: accountId ?? null })}`),

  startBackup: (accountId?: string | null) =>
    request<{ ok: true; status: BackupStatus }>(`backup/start${query({ accountId: accountId ?? null })}`, {
      method: 'POST',
    }),

  stopBackup: (accountId?: string | null) =>
    request<{ ok: boolean; status: BackupStatus }>(`backup/stop${query({ accountId: accountId ?? null })}`, {
      method: 'POST',
    }),
}

export type { AttachmentMeta }
