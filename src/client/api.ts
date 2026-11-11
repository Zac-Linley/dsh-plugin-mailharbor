import type {
  Account,
  AiCard,
  AiSearchFilters,
  AiThread,
  Project,
  Task,
  TaskSuggestion,
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

export interface AiStatus {
  available: boolean
  enabled: boolean
  provider: string
  model: string
  styleUpdatedAt: string
  styleSampleCount: number
  error?: string
}

export interface StyleProfile {
  profile: string
  updatedAt: string
  sampleCount: number
}

export interface AiModels {
  providers: { provider: string; name: string; models: { id: string; name: string }[] }[]
}

export interface SummaryBlock {
  title: string
  body: string
}

export interface ListParams {
  accountId?: string | null
  source: 'local' | 'server'
  mailbox: string
  query?: string
  offset?: number
  limit?: number
  unread?: boolean
}

export const api = {
  state: (): Promise<AppState> => request<AppState>('state'),

  folders: (params: { accountId?: string | null; source: 'local' | 'server' }) =>
    request<{ items: { name: string; label?: string; count: number }[] }>(`folders${query(params)}`),

  messages: (params: ListParams) =>
    request<Page<MessageSummary>>(
      `messages${query({ ...params, unread: params.unread === true ? 1 : undefined })}`,
    ),

  message: (params: { id: string; accountId?: string | null; source: 'local' | 'server'; mailbox: string }) =>
    request<MessageDetail>(`messages/${encodeURIComponent(params.id)}${query({ ...params })}`),

  star: (params: {
    id: string
    accountId?: string | null
    source: 'local' | 'server'
    mailbox: string
    starred: boolean
  }) =>
    request<{ starred: boolean }>(
      `messages/${encodeURIComponent(params.id)}/star${query({
        accountId: params.accountId ?? null,
        source: params.source,
        mailbox: params.mailbox,
      })}`,
      { method: 'POST', body: JSON.stringify({ starred: params.starred }) },
    ),

  moveMessage: (params: { id: string; accountId?: string | null; mailbox: string; target: string }) =>
    request<{ ok: true; mailbox: string }>(
      `messages/${encodeURIComponent(params.id)}/move${query({
        accountId: params.accountId ?? null,
      })}`,
      { method: 'POST', body: JSON.stringify({ target: params.target }) },
    ),

  bulkAction: (payload: {
    accountId?: string | null
    action: 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'delete' | 'move'
    target?: string
    ids: string[]
  }) =>
    request<{ ok: true; count: number }>('messages/bulk', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

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

  aiStatus: (accountId?: string | null) =>
    request<AiStatus>(`ai/status${query({ accountId: accountId ?? null })}`),

  aiModels: () => request<AiModels>('ai/models'),

  aiSearch: (payload: {
    accountId: string | null
    source: 'local' | 'server'
    mailbox: string
    query: string
  }) =>
    request<Page<MessageSummary> & { ai: AiSearchFilters }>('ai/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiThread: (accountId: string | null, key: string) =>
    request<{ thread: AiThread | null }>(`ai/thread${query({ accountId: accountId ?? null, key })}`),

  aiAddCard: (payload: {
    accountId?: string | null
    key: string
    kind: 'summary' | 'reply' | 'translate' | 'answer'
    instruction?: string
    language?: 'zh' | 'en'
    target?: 'zh' | 'en'
    length?: 'brief' | 'normal' | 'detailed'
    source: 'local' | 'server'
    id: string
    mailbox: string
  }) =>
    request<{ card: AiCard; thread: AiThread }>('ai/cards', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiDeleteCard: (accountId: string | null, key: string, cardId: string) =>
    request<{ thread: AiThread | null }>(`ai/cards${query({ accountId: accountId ?? null, key, cardId })}`, {
      method: 'DELETE',
    }),

  aiClearThread: (accountId: string | null, key: string) =>
    request<{ ok: boolean }>(`ai/thread${query({ accountId: accountId ?? null, key })}`, {
      method: 'DELETE',
    }),

  aiCompose: (payload: {
    accountId?: string | null
    mode: 'draft' | 'polish' | 'shorten'
    instruction?: string
    html: string
    language?: 'zh' | 'en'
  }) =>
    request<{ text: string; html: string }>('ai/compose', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiSummary: (payload: {
    accountId?: string | null
    source: 'local' | 'server'
    id: string
    mailbox: string
  }) =>
    request<{ summary: string; blocks: SummaryBlock[] }>('ai/summary', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiReply: (payload: {
    accountId?: string | null
    source: 'local' | 'server'
    id: string
    mailbox: string
    instruction?: string
    language?: 'zh' | 'en'
  }) =>
    request<{ text: string; html: string }>('ai/reply', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiTranslate: (payload: { accountId?: string | null; html: string; target: 'zh' | 'en' }) =>
    request<{ text: string; html: string }>('ai/translate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiStyle: (accountId?: string | null) =>
    request<{ style: StyleProfile | null }>(`ai/style${query({ accountId: accountId ?? null })}`),

  aiSaveStyle: (accountId: string | null, profile: string) =>
    request<{ style: StyleProfile }>(`ai/style${query({ accountId: accountId ?? null })}`, {
      method: 'PUT',
      body: JSON.stringify({ accountId, profile }),
    }),

  aiLearnStyle: (accountId?: string | null) =>
    request<{ style: StyleProfile }>(`ai/style/learn${query({ accountId: accountId ?? null })}`, {
      method: 'POST',
      body: JSON.stringify({ accountId: accountId ?? null }),
    }),

  tasks: (accountId: string | null, params: { status?: string; projectId?: string; query?: string } = {}) =>
    request<{ items: Task[]; calendar: { calendarHref: string; lastSync: string; error: string } | null }>(
      `tasks${query({ accountId: accountId ?? null, ...params })}`,
    ),

  createTask: (payload: Record<string, unknown>) =>
    request<{ task: Task }>('tasks', { method: 'POST', body: JSON.stringify(payload) }),

  updateTask: (id: string, patch: Record<string, unknown>) =>
    request<{ task: Task }>(`tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteTask: (id: string) => request<{ ok: true }>(`tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  extractTasks: (payload: {
    accountId?: string | null
    source: 'local' | 'server'
    id: string
    mailbox: string
  }) =>
    request<{ suggestions: TaskSuggestion[] }>('tasks/extract', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  taskCaldav: (accountId: string | null) =>
    request<{
      caldav: { url: string; username: string; calendarHref?: string } | null
      calendar: { calendarHref: string; lastSync: string; error: string } | null
      hasPassword: boolean
    }>(`tasks/caldav${query({ accountId: accountId ?? null })}`),

  saveTaskCaldav: (payload: {
    accountId?: string | null
    url: string
    username: string
    password?: string
    calendarHref?: string
  }) =>
    request<{ caldav: unknown; hasPassword: boolean }>('tasks/caldav', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  syncTasks: (accountId: string | null) =>
    request<{
      result: { pulled: number; pushed: number; deleted: number; removed: number }
      calendar: unknown
    }>('tasks/sync', { method: 'POST', body: JSON.stringify({ accountId }) }),

  projects: () => request<{ items: Project[] }>('projects'),

  pickDirectory: () => request<{ path: string | null }>('projects/pick-directory', { method: 'POST' }),

  updateProject: (id: string, name: string) =>
    request<{ project: Project }>(`projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean; path: string; unlinkedTasks: number; workspaceKept: boolean }>(
      `projects/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  openProject: (id: string) =>
    request<{ path: string }>(`projects/${encodeURIComponent(id)}/open`, { method: 'POST' }),

  projectFor: (accountId: string | null, key: string) =>
    request<{ project: Project | null }>(`projects/for${query({ accountId: accountId ?? null, key })}`),

  createProject: (payload: {
    accountId?: string | null
    name: string
    root: string
    conversation: string
    message?: { key: string; subject: string; date: string }
  }) =>
    request<{ project: Project; warnings: string[] }>('projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  addProjectMessage: (
    id: string,
    payload: { accountId?: string | null; key: string; subject: string; date: string },
  ) =>
    request<{ project: Project }>(`projects/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  removeProjectMessage: (id: string, accountId: string | null, key: string) =>
    request<{ project: Project }>(
      `projects/${encodeURIComponent(id)}/messages${query({ accountId: accountId ?? null, key })}`,
      { method: 'DELETE' },
    ),

  transferProject: (id: string, payload: { accountId?: string | null; key?: string; conversation: string }) =>
    request<{ project: Project }>(`projects/${encodeURIComponent(id)}/transfer`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  lookupMessage: (accountId: string | null, key: string) =>
    request<{ id: string; mailbox: string; subject: string }>(
      `messages/lookup${query({ accountId: accountId ?? null, key })}`,
    ),

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
