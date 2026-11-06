import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, BackupStatus, MessageDetail, MessageSummary, Page } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { AddAccountForm, AddAccountModal, LoginForm } from './account-form.js'
import { Avatar, ErrorBar, Modal, shortDate } from './components.js'
import { Composer, type ComposeInit } from './composer.js'
import { Reader } from './reader.js'

interface Folder {
  name: string
  label?: string
  count: number
}

const EMPTY_PAGE: Page<MessageSummary> = { items: [], total: 0, offset: 0, limit: 40 }

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function matchesNarrow(): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 900px)').matches : false
}

function quoteForReply(detail: MessageDetail): string {
  const body = detail.html ?? `<pre>${detail.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`
  return `<p><br></p><p>------------------ 原始邮件 ------------------</p><blockquote style="margin:0 0 0 12px;padding-left:12px;border-left:2px solid #d7dbe3;color:#565c67">${body}</blockquote>`
}

export function MailPanel(): ReactNode {
  const [state, setState] = useState<AppState | null>(null)
  const [error, setError] = useState('')
  const [source, setSource] = useState<'local' | 'server'>('local')
  const [mailbox, setMailbox] = useState('all')
  const [folders, setFolders] = useState<Folder[]>([])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<Page<MessageSummary>>(EMPTY_PAGE)
  const [limit, setLimit] = useState(40)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<MessageDetail | null>(null)
  const [compose, setCompose] = useState<ComposeInit | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [toast, setToast] = useState('')
  const [narrow, setNarrow] = useState(() => matchesNarrow())
  const [tick, setTick] = useState(0)
  const account = state?.accounts.find((item) => item.id === state.activeAccountId) ?? null
  const accountId = account?.id ?? null

  const refresh = useCallback((): void => {
    setTick((value) => value + 1)
  }, [])

  const notice = useCallback((message: string): void => {
    setToast(message)
    window.setTimeout(() => {
      setToast('')
    }, 3200)
  }, [])

  // App state: load once and after mutations.
  useEffect(() => {
    let cancelled = false
    api
      .state()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  // Folders follow the account and the source.
  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    api
      .folders({ accountId, source })
      .then((result) => {
        if (cancelled) return
        const items: Folder[] =
          source === 'local'
            ? [
                {
                  name: 'all',
                  label: '全部邮件',
                  count: result.items.reduce((sum, item) => sum + item.count, 0),
                },
                ...result.items.map((item) => ({ ...item, label: item.label ?? item.name })),
              ]
            : result.items.map((item) => ({ ...item, label: item.label ?? item.name }))
        setFolders(items)
      })
      .catch(() => {
        if (!cancelled) setFolders([])
      })
    return () => {
      cancelled = true
    }
  }, [accountId, source, tick])

  // Selecting a source resets the folder to that source's natural default.
  useEffect(() => {
    setMailbox(source === 'local' ? 'all' : 'INBOX')
    setSelected(null)
    setLimit(state?.settings.render.listLimit ?? 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Message page.
  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    setLoading(true)
    api
      .messages({ accountId, source, mailbox, query: search, limit })
      .then((result) => {
        if (!cancelled) setPage(result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, source, mailbox, search, limit, tick])

  // Narrow layout follows the viewport. Host pages without matchMedia keep the
  // wide layout, which still works because both panes are scrollable.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 900px)')
    const onChange = (): void => setNarrow(media.matches)
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])

  // Backup progress polling while the dialog is open.
  useEffect(() => {
    if (!showBackup || accountId === null) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const status = await api.backupStatus(accountId)
        if (!cancelled) setBackup(status)
      } catch {
        // Keep the last status.
      }
    }
    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [showBackup, accountId])

  const openMessage = async (item: MessageSummary): Promise<void> => {
    if (account === null) return
    setError('')
    try {
      const detail = await api.message({ id: item.id, accountId: account.id, source, mailbox })
      setSelected(detail)
      if (detail.unread && state?.settings.read.markOnOpen === true) {
        try {
          await api.setRead({ id: detail.id, accountId: account.id, source, mailbox, read: true })
          setSelected({ ...detail, unread: false })
          setPage((current) => ({
            ...current,
            items: current.items.map((row) => (row.id === item.id ? { ...row, unread: false } : row)),
          }))
        } catch {
          // Reading must not fail because the server refused a flag write.
        }
      }
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const startCompose = (mode: ComposeInit['mode']): void => {
    if (account === null) return
    const detail = selected
    if (mode === 'new' || detail === null) {
      setCompose({ mode: 'new', to: '', cc: '', bcc: '', subject: '', html: '' })
      return
    }
    const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
    const subject = /^(re|fwd):/i.test(detail.subject) ? detail.subject : `${subjectPrefix}${detail.subject}`
    if (mode === 'forward') {
      setCompose({
        mode,
        to: '',
        cc: '',
        bcc: '',
        subject,
        html: quoteForReply(detail),
        references: detail.references.join(' '),
      })
      return
    }
    const to = detail.from.address
    const cc =
      mode === 'replyAll'
        ? [...detail.to, ...detail.cc]
            .map((item) => item.address)
            .filter((address) => address !== account.email && address !== to)
            .join(', ')
        : ''
    setCompose({
      mode,
      to,
      cc,
      bcc: '',
      subject,
      html: quoteForReply(detail),
      ...(detail.messageId === ''
        ? {}
        : { inReplyTo: detail.messageId, references: [...detail.references, detail.messageId].join(' ') }),
    })
  }

  const switchAccount = async (id: string): Promise<void> => {
    try {
      await api.activateAccount(id)
      setSelected(null)
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const startBackup = async (): Promise<void> => {
    if (accountId === null) return
    try {
      const result = await api.startBackup(accountId)
      setBackup(result.status)
      setShowBackup(true)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const stopBackup = async (): Promise<void> => {
    if (accountId === null) return
    try {
      const result = await api.stopBackup(accountId)
      setBackup(result.status)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const folderOptions = useMemo(
    () =>
      folders.map((folder) => ({
        value: folder.name,
        label: `${folder.label ?? folder.name}${folder.count > 0 ? ` (${String(folder.count)})` : ''}`,
      })),
    [folders],
  )

  const unreadCount = page.items.filter((item) => item.unread).length

  if (state === null) {
    return h('div', { className: 'mailharbor mailharbor-empty' }, error === '' ? '正在加载邮箱…' : error)
  }

  if (account === null) {
    return h(
      'div',
      { className: 'mailharbor' },
      h(
        'div',
        { className: 'mailharbor-settings' },
        h('h2', null, '欢迎使用 MailHarbor'),
        h(
          'p',
          { className: 'muted small' },
          '把任意 IMAP/SMTP 邮箱接进 DeepSeek Harness：本地备份、实时读信、写邮件、AI 与任务。',
        ),
        error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
        h(AddAccountForm, {
          onDone: (next) => {
            setState(next)
            setSource('local')
          },
        }),
      ),
    )
  }

  const needsLogin = source === 'server' && state.loggedIn === false

  return h(
    'div',
    { className: narrow ? 'mailharbor mailharbor-narrow' : 'mailharbor' },
    h(
      'div',
      { className: 'mailharbor-topbar' },
      h(Avatar, { email: account.email, size: 26 }),
      state.accounts.length > 1
        ? h(
            'select',
            {
              value: account.id,
              onChange: (event: { target: { value: string } }) => void switchAccount(event.target.value),
              'aria-label': '账号',
            },
            state.accounts.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          )
        : h('span', { className: 'small' }, account.label),
      h(
        'div',
        { className: 'mailharbor-segment', role: 'tablist' },
        h(
          'button',
          { className: source === 'local' ? 'active' : '', onClick: () => setSource('local'), role: 'tab' },
          '本地备份',
        ),
        h(
          'button',
          { className: source === 'server' ? 'active' : '', onClick: () => setSource('server'), role: 'tab' },
          '服务器实时',
        ),
      ),
      h('span', { className: 'spacer' }),
      state.loggedIn === false ? h('span', { className: 'badge warn' }, '未登录') : null,
      h('button', { className: 'ghost', onClick: () => setShowAdd(true), title: '添加账号' }, '+ 账号'),
      h('button', { className: 'primary', onClick: () => startCompose('new') }, '写邮件'),
      h('button', { className: 'ghost', onClick: () => void startBackup() }, '备份'),
      h(
        'button',
        {
          className: 'ghost',
          onClick: () => {
            refresh()
          },
        },
        '刷新',
      ),
    ),
    toast === ''
      ? null
      : h('div', { className: 'small', style: { padding: '6px 12px', color: 'var(--m-ok)' } }, toast),
    error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),
    needsLogin
      ? h('div', { className: 'mailharbor-settings' }, h(LoginForm, { account, onDone: refresh }))
      : h(
          'div',
          { className: 'mailharbor-body', 'data-mode': narrow && selected !== null ? 'reader' : 'list' },
          h(
            'div',
            { className: 'mailharbor-list' },
            h(
              'div',
              { className: 'mailharbor-filters' },
              h(
                'select',
                {
                  value: mailbox,
                  onChange: (event: { target: { value: string } }) => {
                    setMailbox(event.target.value)
                    setSelected(null)
                  },
                  'aria-label': '邮箱文件夹',
                },
                folderOptions.map((option) =>
                  h('option', { key: option.value, value: option.value }, option.label),
                ),
              ),
              h('input', {
                type: 'search',
                placeholder: '搜索邮件',
                value: query,
                onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
                onKeyDown: (event: { key: string }) => {
                  if (event.key === 'Enter') setSearch(query)
                  if (event.key === 'Escape') {
                    setQuery('')
                    setSearch('')
                  }
                },
              }),
              query !== search || search !== ''
                ? h(
                    'button',
                    {
                      className: 'subtle small',
                      onClick: () => {
                        setQuery('')
                        setSearch('')
                      },
                    },
                    '清除',
                  )
                : null,
            ),
            h(
              'div',
              { className: 'mailharbor-rows' },
              loading && page.items.length === 0
                ? h('div', { className: 'mailharbor-empty' }, '正在读取…')
                : page.items.length === 0
                  ? h(
                      'div',
                      { className: 'mailharbor-empty' },
                      source === 'local'
                        ? '本地备份里还没有邮件。点顶部「备份」把服务器邮件同步下来。'
                        : '服务器上没有邮件。',
                    )
                  : page.items.map((item) =>
                      h(
                        'button',
                        {
                          key: item.id,
                          className: `mailharbor-row${item.unread ? ' unread' : ''}${selected?.id === item.id ? ' selected' : ''}`,
                          onClick: () => void openMessage(item),
                        },
                        h(
                          'span',
                          { className: 'line-1' },
                          h(
                            'span',
                            { className: 'from' },
                            item.from.name !== '' ? item.from.name : item.from.address,
                          ),
                          item.backedUp === false ? h('span', { className: 'badge warn' }, '未备份') : null,
                          h('span', { className: 'date' }, shortDate(item.date)),
                        ),
                        h('span', { className: 'line-2' }, h('span', { className: 'subject' }, item.subject)),
                        item.snippet === '' ? null : h('span', { className: 'snippet' }, item.snippet),
                      ),
                    ),
              page.items.length > 0
                ? h(
                    'div',
                    { style: { padding: '10px 12px', display: 'flex', gap: '8px', alignItems: 'center' } },
                    h(
                      'span',
                      { className: 'small muted' },
                      `${String(page.items.length)} / ${String(page.total)} 封${unreadCount > 0 ? ` · ${String(unreadCount)} 未读` : ''}`,
                    ),
                    h('span', { className: 'spacer' }),
                    page.total > page.items.length
                      ? h(
                          'button',
                          { className: 'subtle small', onClick: () => setLimit((current) => current + 40) },
                          '加载更多',
                        )
                      : null,
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'mailharbor-reader' },
            selected === null
              ? h(
                  'div',
                  { className: 'mailharbor-empty' },
                  h('p', null, '从左侧选择一封邮件'),
                  h(
                    'p',
                    { className: 'small' },
                    state.loggedIn
                      ? '已登录，可切换「服务器实时」查看最新邮件。'
                      : '浏览本地备份不需要登录。',
                  ),
                )
              : h(Reader, {
                  detail: selected,
                  account,
                  source,
                  mailbox,
                  onChanged: (patch) => setSelected({ ...selected, ...patch }),
                  onReply: (mode) => startCompose(mode),
                  onClose: narrow ? () => setSelected(null) : undefined,
                }),
          ),
        ),
    showBackup && backup !== null
      ? h(
          Modal,
          {
            title: '备份',
            onClose: () => setShowBackup(false),
            footer: h(
              'div',
              { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } },
              h('span', { className: 'small muted' }, backup.running ? '备份进行中…' : backup.message),
              h('span', { className: 'spacer' }),
              backup.running
                ? h('button', { className: 'danger ghost', onClick: () => void stopBackup() }, '停止备份')
                : h('button', { className: 'primary', onClick: () => void startBackup() }, '开始备份'),
              h('button', { className: 'ghost', onClick: () => setShowBackup(false) }, '关闭'),
            ),
          },
          h(
            'div',
            { className: 'mailharbor-kv' },
            h('dt', null, '开始时间'),
            h('dd', null, backup.startedAt ?? '—'),
            h('dt', null, '上次成功'),
            h('dd', null, backup.lastSuccessAt ?? '—'),
            h('dt', null, '新增'),
            h('dd', null, String(backup.added)),
            h('dt', null, '总数'),
            h('dd', null, String(backup.total)),
          ),
          h(
            'div',
            { className: 'mailharbor-log' },
            backup.output.length === 0 ? '（等待输出…）' : backup.output.join('\n'),
          ),
        )
      : null,
    compose !== null
      ? h(Composer, {
          account,
          initial: compose,
          onClose: () => setCompose(null),
          onSent: (message) => notice(message),
        })
      : null,
    showAdd
      ? h(AddAccountModal, {
          onClose: () => setShowAdd(false),
          onDone: (next) => {
            setState(next)
            refresh()
          },
        })
      : null,
  )
}
