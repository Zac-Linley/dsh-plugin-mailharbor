// @vitest-environment jsdom
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailPanel } from '../src/client/panel.js'
import type { AppState } from '../src/shared/types.js'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    version: '0.1.0',
    settings: {
      dataDir: '/tmp/mailharbor',
      configFile: '/tmp/mailharbor/config.json',
      signature: '',
      accounts: [],
      activeAccountId: null,
      ai: {
        enabled: true,
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        styleSampleCount: 100,
        summaryLength: 'brief',
      },
      read: { markOnOpen: true, pollSeconds: 60 },
      render: { listLimit: 40 },
      projects: { root: '/tmp/projects' },
    },
    accounts: [],
    activeAccountId: null,
    backup: {
      running: false,
      accountId: null,
      startedAt: null,
      finishedAt: null,
      lastSuccessAt: null,
      total: 0,
      added: 0,
      message: '',
      output: [],
      exitCode: null,
    },
    unread: 0,
    loggedIn: false,
    ...overrides,
  }
}

const account = {
  id: 'acc_1',
  label: 'Work',
  email: 'me@example.com',
  username: 'me@example.com',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, fromName: '' },
  keychainService: 'dsh-mailharbor:acc_1',
  dataDir: 'accounts/acc_1',
  auth: { type: 'password' as const },
  caldav: null,
  enabled: true,
  createdAt: '2026-11-06T00:00:00.000Z',
}

let container: HTMLDivElement

function respond(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  container.remove()
  vi.unstubAllGlobals()
})

function mockApi(app: AppState): (input: string | URL | Request) => Promise<Response> {
  return (input) => {
    const url = String(input)
    if (url.includes('/folders')) return Promise.resolve(respond({ items: [{ name: 'INBOX', count: 2 }] }))
    if (url.includes('/messages/')) return Promise.resolve(respond({ error: 'not found' }))
    if (url.includes('/messages')) {
      return Promise.resolve(
        respond({
          items: [
            {
              id: '1',
              accountId: account.id,
              subject: 'Hello there',
              from: { name: 'Alice', address: 'alice@example.com' },
              to: [],
              date: '2026-11-01T09:00:00.000Z',
              unread: true,
              flagged: false,
              hasAttachments: false,
              snippet: 'Body text',
              mailbox: 'INBOX',
              backedUp: true,
            },
          ],
          total: 1,
          offset: 0,
          limit: 40,
        }),
      )
    }
    return Promise.resolve(respond(app))
  }
}

async function render(element: ReactElement): Promise<void> {
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  // Let the state request settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  ;(container as HTMLDivElement & { __root?: ReturnType<typeof createRoot> }).__root = root
}

describe('MailPanel rendering', () => {
  it('shows the onboarding form when no account exists', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(state())))
    await render(h(MailPanel))
    expect(container.textContent).toContain('欢迎使用 MailHarbor')
    expect(container.textContent).toContain('添加邮箱账号')
  })

  it('shows the mailbox workspace for a logged-in account', async () => {
    const app = state({
      accounts: [account],
      activeAccountId: account.id,
      loggedIn: true,
      settings: {
        ...state().settings,
        accounts: [account],
        activeAccountId: account.id,
      },
    })
    vi.stubGlobal('fetch', mockApi(app))
    await render(h(MailPanel))
    expect(container.textContent).toContain('Work')
    expect(container.textContent).toContain('写邮件')
    expect(container.textContent).toContain('Hello there')
    expect(container.textContent).toContain('Alice')
  })

  it('opens the local backup without asking for a login', async () => {
    const app = state({
      accounts: [account],
      activeAccountId: account.id,
      loggedIn: false,
      settings: { ...state().settings, accounts: [account], activeAccountId: account.id },
    })
    vi.stubGlobal('fetch', mockApi(app))
    await render(h(MailPanel))
    expect(container.textContent).not.toContain('登录 me@example.com')
    expect(container.textContent).toContain('同步')
  })
})
