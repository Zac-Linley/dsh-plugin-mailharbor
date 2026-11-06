import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, BackupStatus, Draft, MessageDetail, MessageSummary, Page } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { AddAccountForm, AddAccountModal, LoginForm } from './account-form.js'
import { Avatar, ErrorBar, Modal, shortDate } from './components.js'
import { Composer, type ComposeInit } from './composer.js'
import { Icon } from './icons.js'
import { Reader } from './reader.js'

interface Folder {
  name: string
  label?: string
  count: number
}

const EMPTY_PAGE: Page<MessageSummary> = { items: [], total: 0, offset: 0, limit: 40 }
const DRAFTS = '__drafts'

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
  const [accountScope, setAccountScope] = useState<string | null>(null)
  const [source, setSource] = useState<'local' | 'server'>('local')
  const [mailbox, setMailbox] = useState('all')
  const [folders, setFolders] = useState<Folder[]>([])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<Page<MessageSummary>>(EMPTY_PAGE)
  const [drafts, setDrafts] = useState<Draft[]>([])
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

  const accounts = state?.accounts ?? []
  const isAll = accountScope === 'all'
  const account = accounts.find((item) => item.id === accountScope) ?? null
  const composeAccount =
    accounts.find((item) => item.id === compose?.accountId) ?? account ?? accounts[0] ?? null
  const showingDrafts = mailbox === DRAFTS && source === 'local'

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
        if (cancelled) return
        setState(next)
        if (next.settings.render.listLimit > 0) setLimit(next.settings.render.listLimit)
        setAccountScope((current) => current ?? next.activeAccountId)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  // Folders follow the account scope and the source.
  useEffect(() => {
    if (accountScope === null) return
    let cancelled = false
    api
      .folders({ accountId: accountScope, source })
      .then((result) => {
        if (cancelled) return
        const items: Folder[] =
          source === 'local'
            ? [
                {
                  name: 'all',
                  label: '全部邮件',
                  count: result.items
                    .filter((item) => item.name !== DRAFTS)
                    .reduce((sum, item) => sum + item.count, 0),
                },
                ...result.items.map((item) => ({
                  ...item,
                  label: item.name === DRAFTS ? '草稿' : (item.label ?? item.name),
                })),
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
  }, [accountScope, source, tick])

  // A source or account switch resets the folder; unified inbox is local-only.
  useEffect(() => {
    setMailbox(source === 'local' ? 'all' : 'INBOX')
    setSelected(null)
    setLimit(state?.settings.render.listLimit ?? 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    if (accountScope === 'all' && source === 'server') setSource('local')
    setSelected(null)
  }, [accountScope, source])

  // Message page (or drafts list).
  useEffect(() => {
    if (accountScope === null) return
    let cancelled = false
    setLoading(true)
    if (showingDrafts) {
      const targets = isAll ? accounts : account === null ? [] : [account]
      Promise.all(
        targets.map(async (target) => {
          try {
            const result = await api.drafts(target.id)
            return result.items.map((draft) => ({ ...draft, accountId: target.id }))
          } catch {
            return []
          }
        }),
      )
        .then((groups) => {
          if (cancelled) return
          setDrafts(groups.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
          setPage(EMPTY_PAGE)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    api
      .messages({ accountId: accountScope, source, mailbox, query: search, limit })
      .then((result) => {
        if (!cancelled) {
          setPage(result)
          setDrafts([])
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountScope, source, mailbox, search, limit, tick])

  // Narrow layout follows the viewport.
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
    if (!showBackup || accountScope === null || isAll) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const status = await api.backupStatus(accountScope)
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
  }, [showBackup, accountScope, isAll])

  const openMessage = async (item: MessageSummary): Promise<void> => {
    const owner = item.accountId
    const ownerSource = source
    setError('')
    try {
      const detail = await api.message({ id: item.id, accountId: owner, source: ownerSource, mailbox })
      setSelected(detail)
      if (detail.unread && state?.settings.read.markOnOpen === true) {
        try {
          await api.setRead({ id: detail.id, accountId: owner, source: ownerSource, mailbox, read: true })
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
    const owner = account ?? accounts.find((item) => item.id === state?.activeAccountId) ?? accounts[0]
    if (owner === undefined) return
    const detail = selected
    if (mode === 'new' || detail === null) {
      setCompose({ mode: 'new', accountId: owner.id, to: '', cc: '', bcc: '', subject: '', html: '' })
      return
    }
    const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
    const subject = /^(re|fwd):/i.test(detail.subject) ? detail.subject : `${subjectPrefix}${detail.subject}`
    if (mode === 'forward') {
      setCompose({
        mode,
        accountId: detail.accountId,
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
            .filter((address) => address !== owner.email && address !== to)
            .join(', ')
        : ''
    setCompose({
      mode,
      accountId: detail.accountId,
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

  const openDraft = (draft: Draft): void => {
    setCompose({
      mode: 'new',
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      attachments: draft.attachments,
      draftId: draft.id,
    })
  }

  const removeDraft = async (id: string, accountId: string): Promise<void> => {
    try {
      await api.deleteDraft(id, accountId)
      setDrafts((current) => current.filter((draft) => draft.id !== id))
      notice('草稿已删除')
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const switchAccount = async (id: string): Promise<void> => {
    try {
      if (id !== 'all') await api.activateAccount(id)
      setAccountScope(id)
      setSelected(null)
      if (id === 'all') setSource('local')
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const startBackup = async (): Promise<void> => {
    const owner =
      accountScope === null || isAll ? accounts[0] : accounts.find((item) => item.id === accountScope)
    if (owner === undefined) return
    try {
      const result = await api.startBackup(owner.id)
      setBackup(result.status)
      setShowBackup(true)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const stopBackup = async (): Promise<void> => {
    if (accountScope === null || isAll) return
    try {
      const result = await api.stopBackup(accountScope)
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

  if (state === null) {
    return h(
      'div',
      { className: 'mailharbor' },
      h('div', { className: 'mailharbor-empty' }, error === '' ? '正在加载邮箱…' : error),
    )
  }

  if (accounts.length === 0) {
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
          '把任意 IMAP/SMTP 邮箱接进 DeepSeek Harness：本地备份、实时读信、写邮件与 Agent 工具。',
        ),
        error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
        h(AddAccountForm, {
          onDone: (next) => {
            setState(next)
            setAccountScope(next.activeAccountId)
            setSource('local')
          },
        }),
      ),
    )
  }

  const currentAccount = account ?? accounts[0] ?? null
  const loggedIn = isAll ? accounts.some((item) => item.id === state.activeAccountId) : state.loggedIn
  const needsLogin = source === 'server' && !isAll && state.loggedIn === false
  const items = page.items

  return h(
    'div',
    { className: narrow ? 'mailharbor mailharbor-narrow' : 'mailharbor' },
    h(
      'div',
      { className: 'mailharbor-topbar' },
      h(
        'div',
        { className: 'mailharbor-account' },
        h(Avatar, { email: isAll ? 'all' : (currentAccount?.email ?? '?'), size: 26 }),
        accounts.length > 1
          ? h(
              'select',
              {
                value: accountScope ?? '',
                onChange: (event: { target: { value: string } }) => void switchAccount(event.target.value),
                'aria-label': '账号',
              },
              h('option', { key: 'all', value: 'all' }, '全部账号'),
              accounts.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            )
          : h('span', { className: 'name' }, currentAccount?.label ?? ''),
        isAll ? h('span', { className: 'badge' }, `${String(accounts.length)} 个账号`) : null,
        !isAll && state.loggedIn === false ? h('span', { className: 'badge warn' }, '未登录') : null,
      ),
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
          {
            className: source === 'server' ? 'active' : '',
            onClick: () => {
              if (isAll) {
                notice('统一收件箱只支持本地备份，切换到单个账号可使用服务器实时')
                return
              }
              setSource('server')
            },
            role: 'tab',
            title: isAll ? '统一收件箱只支持本地备份' : '读取服务器上的最新邮件',
          },
          '服务器实时',
        ),
      ),
      h('span', { className: 'spacer' }),
      h(
        'button',
        {
          className: 'ghost icon',
          title: '添加账号',
          'aria-label': '添加账号',
          onClick: () => setShowAdd(true),
        },
        h(Icon, { name: 'plus' }),
      ),
      h(
        'button',
        { className: 'ghost icon', title: '刷新列表', 'aria-label': '刷新列表', onClick: refresh },
        h(Icon, { name: 'refresh' }),
      ),
      h(
        'button',
        {
          className: 'ghost',
          onClick: () => void startBackup(),
          title: isAll ? '备份当前活动账号' : '备份这个账号',
        },
        h(Icon, { name: 'archive' }),
        '备份',
      ),
      h(
        'button',
        { className: 'primary', onClick: () => startCompose('new') },
        h(Icon, { name: 'compose' }),
        '写邮件',
      ),
    ),
    toast === ''
      ? null
      : h('div', { className: 'small', style: { padding: '6px 14px', color: 'var(--m-ok)' } }, toast),
    error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),
    needsLogin
      ? h(
          'div',
          { className: 'mailharbor-settings' },
          h(LoginForm, { account: currentAccount!, onDone: refresh }),
        )
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
                placeholder: showingDrafts ? '搜索草稿' : '搜索邮件',
                'aria-label': '搜索邮件',
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
                      className: 'subtle',
                      title: '清除搜索',
                      onClick: () => {
                        setQuery('')
                        setSearch('')
                      },
                    },
                    h(Icon, { name: 'close', size: 14 }),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'mailharbor-rows' },
              loading && items.length === 0 && drafts.length === 0
                ? h('div', { className: 'mailharbor-empty' }, '正在读取…')
                : showingDrafts
                  ? drafts.length === 0
                    ? h(
                        'div',
                        { className: 'mailharbor-empty' },
                        h(Icon, { name: 'compose', size: 28 }),
                        h('div', { className: 'title' }, '没有草稿'),
                        h('div', { className: 'small' }, '写信时点「存草稿」会出现在这里。'),
                      )
                    : drafts
                        .filter((draft) =>
                          search === ''
                            ? true
                            : `${draft.subject} ${draft.to} ${draft.cc}`
                                .toLowerCase()
                                .includes(search.toLowerCase()),
                        )
                        .map((draft) =>
                          h(
                            'div',
                            {
                              key: draft.id,
                              className: 'mailharbor-row',
                              role: 'button',
                              tabIndex: 0,
                              onClick: () => openDraft(draft),
                              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  openDraft(draft)
                                }
                              },
                            },
                            h(
                              'span',
                              { className: 'line-1' },
                              h(
                                'span',
                                { className: 'from' },
                                `草稿${draft.to === '' ? '' : ` · 收件人 ${draft.to}`}`,
                              ),
                              isAll
                                ? h(
                                    'span',
                                    { className: 'badge' },
                                    accounts.find((item) => item.id === draft.accountId)?.label ?? '',
                                  )
                                : null,
                              h('span', { className: 'date' }, shortDate(draft.updatedAt)),
                              h(
                                'button',
                                {
                                  className: 'subtle',
                                  title: '删除草稿',
                                  onClick: (event: { stopPropagation: () => void }) => {
                                    event.stopPropagation()
                                    void removeDraft(draft.id, draft.accountId)
                                  },
                                },
                                h(Icon, { name: 'close', size: 13 }),
                              ),
                            ),
                            h(
                              'span',
                              { className: 'line-2' },
                              h(
                                'span',
                                { className: 'subject' },
                                draft.subject === '' ? '(无主题)' : draft.subject,
                              ),
                            ),
                            draft.html === ''
                              ? null
                              : h(
                                  'span',
                                  { className: 'snippet' },
                                  draft.html
                                    .replace(/<[^>]+>/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .slice(0, 120),
                                ),
                          ),
                        )
                  : items.length === 0
                    ? h(
                        'div',
                        { className: 'mailharbor-empty' },
                        h(Icon, { name: 'mail', size: 28 }),
                        h(
                          'div',
                          { className: 'title' },
                          source === 'local' ? '本地备份里还没有邮件' : '服务器上没有邮件',
                        ),
                        h(
                          'div',
                          { className: 'small' },
                          source === 'local'
                            ? '点顶部「备份」把服务器邮件同步下来。'
                            : '换一个文件夹或稍后刷新。',
                        ),
                      )
                    : items.map((item) =>
                        h(
                          'div',
                          {
                            key: `${item.accountId}:${item.id}`,
                            className: `mailharbor-row${item.unread ? ' unread' : ''}${selected?.id === item.id && selected?.accountId === item.accountId ? ' selected' : ''}`,
                            role: 'button',
                            tabIndex: 0,
                            onClick: () => void openMessage(item),
                            onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                void openMessage(item)
                              }
                            },
                          },
                          h(
                            'span',
                            { className: 'line-1' },
                            item.unread ? h('span', { className: 'dot' }) : null,
                            h(
                              'span',
                              { className: 'from' },
                              item.from.name !== '' ? item.from.name : item.from.address,
                            ),
                            item.hasAttachments ? h(Icon, { name: 'paperclip', size: 13 }) : null,
                            isAll
                              ? h(
                                  'span',
                                  { className: 'badge' },
                                  accounts.find((entry) => entry.id === item.accountId)?.label ?? '',
                                )
                              : null,
                            item.backedUp === false ? h('span', { className: 'badge warn' }, '未备份') : null,
                            h('span', { className: 'date' }, shortDate(item.date)),
                          ),
                          h(
                            'span',
                            { className: 'line-2' },
                            h('span', { className: 'subject' }, item.subject),
                          ),
                          item.snippet === '' ? null : h('span', { className: 'snippet' }, item.snippet),
                        ),
                      ),
            ),
            !showingDrafts && items.length > 0
              ? h(
                  'div',
                  { className: 'mailharbor-list-foot' },
                  h('span', null, `${String(items.length)} / ${String(page.total)} 封`),
                  h('span', { className: 'spacer' }),
                  page.total > items.length
                    ? h(
                        'button',
                        { className: 'subtle', onClick: () => setLimit((current) => current + 40) },
                        '加载更多',
                      )
                    : null,
                )
              : showingDrafts && drafts.length > 0
                ? h(
                    'div',
                    { className: 'mailharbor-list-foot' },
                    h('span', null, `${String(drafts.length)} 封草稿`),
                  )
                : null,
          ),
          h(
            'div',
            { className: 'mailharbor-reader' },
            selected === null
              ? h(
                  'div',
                  { className: 'mailharbor-empty' },
                  h(Icon, { name: 'mail', size: 34 }),
                  h('div', { className: 'title' }, '选择一封邮件开始阅读'),
                  h(
                    'div',
                    { className: 'small' },
                    loggedIn ? '已登录，可切换「服务器实时」查看最新邮件。' : '浏览本地备份不需要登录。',
                  ),
                )
              : h(Reader, {
                  detail: selected,
                  source,
                  mailbox,
                  onChanged: (patch) => setSelected({ ...selected, ...patch }),
                  onReply: (mode) => startCompose(mode),
                  onAiReply: (init) =>
                    setCompose({
                      mode: 'reply',
                      accountId: selected.accountId,
                      to: init.to,
                      cc: init.cc,
                      bcc: '',
                      subject: init.subject,
                      html: init.html,
                      inReplyTo: init.inReplyTo,
                      references: init.references,
                    }),
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
                ? h('button', { className: 'ghost danger', onClick: () => void stopBackup() }, '停止备份')
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
    compose !== null && composeAccount !== null
      ? h(Composer, {
          account: composeAccount,
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
            setAccountScope(next.activeAccountId)
            refresh()
          },
        })
      : null,
  )
}
