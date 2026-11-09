import { createElement as h, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AiSearchFilters,
  AppState,
  BackupStatus,
  Draft,
  MessageDetail,
  MessageSummary,
  Page,
  Project,
  TaskSuggestion,
} from '../shared/types.js'
import { api, ApiError } from './api.js'
import { AiRail, type AiRequest } from './ai-rail.js'
import type { AiReplyInit } from './reply.js'
import { AddAccountForm, AddAccountModal, LoginForm } from './account-form.js'
import { Avatar, ErrorBar, Modal, shortDate } from './components.js'
import { Composer, type ComposeInit } from './composer.js'
import { Icon } from './icons.js'
import { Reader } from './reader.js'
import { consumeOpenMail, type OpenMailRequest } from './nav.js'

interface Folder {
  name: string
  label?: string
  count: number
}

const EMPTY_PAGE: Page<MessageSummary> = { items: [], total: 0, offset: 0, limit: 40 }
const DRAFTS = '__drafts'

/** Paint the last known folders/page while the server answers. */
const folderCache = new Map<string, Folder[]>()
const pageCache = new Map<string, Page<MessageSummary>>()
/** Opened message bodies, so switching back is instant. */
const detailCache = new Map<string, { at: number; detail: MessageDetail }>()
const DETAIL_TTL = 120_000
const DISK_TTL = 6 * 60 * 60 * 1000
const DISK_PREFIX = 'mailharbor.cache.'

/** Persistent cache so a fresh window paints the last mail/folder instantly. */
function readDisk<T>(name: string): T | null {
  try {
    const raw = window.localStorage.getItem(DISK_PREFIX + name)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { at?: number; value?: T }
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > DISK_TTL) return null
    return parsed.value ?? null
  } catch {
    return null
  }
}

function writeDisk<T>(name: string, value: T): void {
  try {
    window.localStorage.setItem(DISK_PREFIX + name, JSON.stringify({ at: Date.now(), value }))
    const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(`${DISK_PREFIX}page.`))
    if (keys.length > 24) {
      for (const key of keys.slice(0, keys.length - 24)) window.localStorage.removeItem(key)
    }
  } catch {
    // Storage full or disabled: the in-memory cache still works.
  }
}

const FOLDER_LABELS: Record<string, string> = {
  INBOX: '收件箱',
  'Sent Items': '已发送',
  Sent: '已发送',
  Drafts: '草稿',
  'Junk E-mail': '垃圾邮件',
  Junk: '垃圾邮件',
  Trash: '已删除',
  Deleted: '已删除',
  Archive: '存档',
}

function folderName(name: string): string {
  return FOLDER_LABELS[name] ?? name
}

function isSentFolder(mailbox: string): boolean {
  return /(^|[/.])(sent|sent items|sent mail|已发送|发件箱)/i.test(mailbox)
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|回复|转发)\s*[:：]\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

interface MessageGroup {
  key: string
  items: MessageSummary[]
}

/** Group a page of mail by conversation title, newest first. */
function groupMessages(items: MessageSummary[]): MessageGroup[] {
  const map = new Map<string, MessageSummary[]>()
  const order: string[] = []
  for (const item of items) {
    const key =
      normalizeSubject(item.subject) === ''
        ? `__${item.accountId}:${item.id}`
        : normalizeSubject(item.subject)
    const existing = map.get(key)
    if (existing === undefined) {
      map.set(key, [item])
      order.push(key)
    } else {
      existing.push(item)
    }
  }
  return order.map((key) => ({ key, items: map.get(key) ?? [] }))
}

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
  const [source, setSource] = useState<'local' | 'server'>('server')
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
  const [railOpen, setRailOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return window.localStorage.getItem('mailharbor.side') !== '0'
    } catch {
      return true
    }
  })
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [projectOptions, setProjectOptions] = useState<Project[]>([])
  const [targetProject, setTargetProject] = useState('')
  const [extraction, setExtraction] = useState<{ items: TaskSuggestion[]; checked: boolean[] } | null>(null)
  const [extractBusy, setExtractBusy] = useState(false)
  const [aiInfo, setAiInfo] = useState<AiSearchFilters | null>(null)
  const [projectPicker, setProjectPicker] = useState<{
    accountId: string
    key: string
    subject: string
    date: string
  } | null>(null)
  const [pickerProjects, setPickerProjects] = useState<Project[]>([])
  const [pickerTarget, setPickerTarget] = useState('')
  const [pickerNewName, setPickerNewName] = useState('')
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerMode, setPickerMode] = useState<'existing' | 'new'>('existing')
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerProjects, setManagerProjects] = useState<Project[]>([])
  const [managerRename, setManagerRename] = useState<{ id: string; name: string } | null>(null)
  const [managerConfirm, setManagerConfirm] = useState('')
  const [managerBusy, setManagerBusy] = useState(false)
  const [aiSearching, setAiSearching] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [aiElapsed, setAiElapsed] = useState(0)
  const hoverTimer = useRef<number | null>(null)
  const folderPrefetchTimers = useRef<number[]>([])
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null)
  const [tick, setTick] = useState(0)

  const accounts = state?.accounts ?? []
  const isAll = accountScope === 'all'
  const account = accounts.find((item) => item.id === accountScope) ?? null
  const composeAccount =
    accounts.find((item) => item.id === compose?.accountId) ?? account ?? accounts[0] ?? null
  const showingDrafts = mailbox === DRAFTS && source === 'local'

  const keyOf = (item: MessageSummary): string =>
    item.messageId !== undefined && item.messageId !== '' ? `mid:${item.messageId}` : `local:${item.id}`

  // The tasks panel can ask the mail panel to open a source message.
  const openFromRequest = useCallback((detail: OpenMailRequest): void => {
    setAccountScope(detail.accountId)
    setSource('local')
    setMailbox(detail.mailbox === '' ? 'all' : detail.mailbox)
    api
      .activateAccount(detail.accountId)
      .then(() => {
        setRailOpen(false)
        return api.message({
          id: detail.id,
          accountId: detail.accountId,
          source: 'local',
          mailbox: detail.mailbox === '' ? 'all' : detail.mailbox,
        })
      })
      .then((message) => setSelected(message))
      .catch((caught: unknown) => setError(errorText(caught)))
  }, [])

  useEffect(() => {
    const queued = consumeOpenMail()
    if (queued !== null) openFromRequest(queued)
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<OpenMailRequest>).detail
      if (detail !== undefined) openFromRequest(detail)
    }
    window.addEventListener('mailharbor:open-mail', onOpen)
    return () => {
      window.removeEventListener('mailharbor:open-mail', onOpen)
    }
  }, [openFromRequest])

  const enterSelect = async (): Promise<void> => {
    setSelectMode(true)
    try {
      const list = await api.projects()
      setProjectOptions(list.items)
      setTargetProject(list.items[0]?.id ?? '')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  useEffect(() => {
    if (!aiSearching) {
      setAiElapsed(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(() => {
      setAiElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [aiSearching])

  const runAiSearch = async (): Promise<void> => {
    const text = query.trim()
    if (text === '' || accountScope === null) return
    setAiSearching(true)
    setError('')
    try {
      const result = await Promise.race([
        api.aiSearch({ accountId: accountScope, source, mailbox, query: text }),
        new Promise<never>((_resolve, reject) => {
          window.setTimeout(() => reject(new Error('AI 搜索超时，已改用普通搜索')), 45_000)
        }),
      ])
      setPage({ items: result.items, total: result.total, offset: 0, limit: result.limit })
      setDrafts([])
      setAiInfo(result.ai)
      setSearch('')
    } catch (caught) {
      // Fall back to the plain text search rather than leaving an empty panel.
      setError(errorText(caught))
      setAiInfo(null)
      setSearch(text)
    } finally {
      setAiSearching(false)
    }
  }

  const openProjectPicker = (): void => {
    if (selected === null) return
    const key = keyOf(selected)
    if (!key.startsWith('mid:') && !key.startsWith('local:')) {
      setError('这封邮件缺少 Message-ID，无法关联到项目')
      return
    }
    setProjectPicker({
      accountId: selected.accountId,
      key,
      subject: selected.subject,
      date: selected.date,
    })
    setPickerNewName(selected.subject.replace(/^(re|fwd):\s*/i, '').slice(0, 80))
    setPickerTarget('')
    void Promise.all([api.projects(), api.projectFor(selected.accountId, key)])
      .then(([list, linked]) => {
        setPickerProjects(list.items)
        const current = linked.project?.id ?? list.items[0]?.id ?? ''
        setPickerTarget(current)
        setPickerMode(current === '' ? 'new' : 'existing')
      })
      .catch((caught: unknown) => setError(errorText(caught)))
  }

  const saveProjectPick = async (): Promise<void> => {
    if (projectPicker === null) return
    setPickerBusy(true)
    setError('')
    try {
      if (pickerMode === 'existing' && pickerTarget !== '') {
        await api.addProjectMessage(pickerTarget, {
          accountId: projectPicker.accountId,
          key: projectPicker.key,
          subject: projectPicker.subject,
          date: projectPicker.date,
        })
        notice('已加入项目')
      } else {
        const name = pickerNewName.trim()
        if (name === '') throw new Error('请填写新项目名称')
        const settings = await api.settings()
        const created = await api.createProject({
          accountId: projectPicker.accountId,
          name,
          root: settings.projects.root,
          conversation: `（从邮件加入）\n\n${projectPicker.subject}`,
          message: {
            key: projectPicker.key,
            subject: projectPicker.subject,
            date: projectPicker.date,
          },
        })
        notice(`项目已创建：${created.project.path}`)
      }
      setProjectPicker(null)
      setTick((value) => value + 1)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setPickerBusy(false)
    }
  }

  const openManager = (): void => {
    setManagerOpen(true)
    setManagerConfirm('')
    setManagerRename(null)
    void api
      .projects()
      .then((list) => setManagerProjects(list.items))
      .catch((caught: unknown) => setError(errorText(caught)))
  }

  const managerAction = async (operation: () => Promise<unknown>): Promise<void> => {
    setManagerBusy(true)
    setError('')
    try {
      await operation()
      const list = await api.projects()
      setManagerProjects(list.items)
      setManagerRename(null)
      setManagerConfirm('')
      setTick((value) => value + 1)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setManagerBusy(false)
    }
  }

  const toggleSide = (): void => {
    setSideOpen((open) => {
      try {
        window.localStorage.setItem('mailharbor.side', open ? '0' : '1')
      } catch {
        // Private mode simply does not persist the preference.
      }
      return !open
    })
  }

  const toggleGroup = (key: string): void => {
    setExpandedGroups((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    )
  }

  const toggleSelect = (item: MessageSummary): void => {
    const key = `${item.accountId}:${item.id}`
    setSelectedKeys((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    )
  }

  const addSelectedToProject = async (): Promise<void> => {
    if (targetProject === '') {
      setError('先创建一个项目')
      return
    }
    const chosen = items
      .filter((item) => selectedKeys.includes(`${item.accountId}:${item.id}`))
      .filter((item) => item.messageId !== undefined && item.messageId !== '')
    if (chosen.length === 0) {
      setError('所选邮件缺少 Message-ID，无法关联到项目')
      return
    }
    try {
      for (const item of chosen) {
        await api.addProjectMessage(targetProject, {
          accountId: item.accountId,
          key: keyOf(item),
          subject: item.subject,
          date: item.date,
        })
      }
      notice(`已加入项目：${String(chosen.length)} 封`)
      setSelectMode(false)
      setSelectedKeys([])
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const extractTasks = async (): Promise<void> => {
    if (selected === null) return
    setExtractBusy(true)
    try {
      const result = await api.extractTasks({
        accountId: selected.accountId,
        source,
        id: selected.id,
        mailbox,
      })
      if (result.suggestions.length === 0) {
        notice('这封邮件没有提取到明确任务')
        return
      }
      setExtraction({ items: result.suggestions, checked: result.suggestions.map(() => true) })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setExtractBusy(false)
    }
  }

  const updateSuggestion = (index: number, patch: Partial<TaskSuggestion>): void => {
    setExtraction((current) =>
      current === null
        ? null
        : {
            ...current,
            items: current.items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
          },
    )
  }

  const removeSuggestion = (index: number): void => {
    setExtraction((current) =>
      current === null
        ? null
        : {
            items: current.items.filter((_item, position) => position !== index),
            checked: current.checked.filter((_value, position) => position !== index),
          },
    )
  }

  const saveExtraction = async (): Promise<void> => {
    if (extraction === null || selected === null) return
    setExtractBusy(true)
    try {
      const key = keyOf(selected)
      for (const [index, suggestion] of extraction.items.entries()) {
        if (!extraction.checked[index]) continue
        await api.createTask({
          accountId: selected.accountId,
          title: suggestion.title,
          notes: suggestion.notes,
          due: suggestion.due,
          priority: suggestion.priority,
          owner: suggestion.owner,
          messageKey: key,
          messageSubject: selected.subject,
        })
      }
      setExtraction(null)
      notice('任务已保存，可在「任务」面板查看')
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setExtractBusy(false)
    }
  }

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
    const cacheKey = `${accountScope}:${source}`
    const cached = folderCache.get(cacheKey) ?? readDisk<Folder[]>(`folders.${cacheKey}`)
    if (cached !== null) setFolders(cached)
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
        folderCache.set(cacheKey, items)
        writeDisk(`folders.${cacheKey}`, items)
      })
      .catch(() => {
        if (!cancelled && cached === undefined) setFolders([])
      })
    return () => {
      cancelled = true
    }
  }, [accountScope, source, tick])

  // A source or account switch resets the folder; unified inbox is local-only.
  useEffect(() => {
    setMailbox(source === 'local' ? 'all' : 'INBOX')
    setSelected(null)
    setAiInfo(null)
    setSearch('')
    setLimit(state?.settings.render.listLimit ?? 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    if (accountScope === 'all' && source === 'server') setSource('local')
    setSelected(null)
    setAiInfo(null)
    setSearch('')
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
    const pageKey = `${accountScope}:${source}:${mailbox}:${search}:${String(limit)}`
    const cachedPage = pageCache.get(pageKey) ?? readDisk<Page<MessageSummary>>(`page.${pageKey}`)
    if (cachedPage !== null) {
      setPage(cachedPage)
      setLoading(false)
    }
    api
      .messages({ accountId: accountScope, source, mailbox, query: search, limit })
      .then((result) => {
        if (!cancelled) {
          setPage(result)
          setDrafts([])
          // The SELECT that listed this folder also tells us its size, so the
          // sidebar count appears without a second round trip.
          if (source === 'server' && mailbox !== 'all') {
            const update = (list: Folder[]): Folder[] =>
              list.map((folder) => (folder.name === mailbox ? { ...folder, count: result.total } : folder))
            setFolders(update)
            const key = `${accountScope}:server`
            const cachedFolders = folderCache.get(key)
            if (cachedFolders !== undefined) folderCache.set(key, update(cachedFolders))
          }
          pageCache.set(pageKey, result)
          writeDisk(`page.${pageKey}`, result)
          if (pageCache.size > 12) {
            const oldest = pageCache.keys().next().value
            if (oldest !== undefined) pageCache.delete(oldest)
          }
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

  const messageKeyOf = (item: MessageSummary): string => `${item.accountId}:${source}:${item.id}`

  const prefetchMessage = (item: MessageSummary): void => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      const key = messageKeyOf(item)
      const cached = detailCache.get(key)
      if (cached !== undefined && Date.now() - cached.at < DETAIL_TTL) return
      void api
        .message({ id: item.id, accountId: item.accountId, source, mailbox })
        .then((detail) => {
          detailCache.set(key, { at: Date.now(), detail })
        })
        .catch(() => undefined)
    }, 160)
  }

  const prefetchFolder = (folder: string): void => {
    if (accountScope === null || source !== 'server' || folder === DRAFTS) return
    const key = `${accountScope}:${source}:${folder}::${String(limit)}`
    const cached = pageCache.get(key)
    if (cached !== undefined) return
    // A hovered folder must not pile up background IMAP jobs.
    for (const timer of folderPrefetchTimers.current) window.clearTimeout(timer)
    folderPrefetchTimers.current = []
    const timer = window.setTimeout(() => {
      void api
        .messages({ accountId: accountScope, source, mailbox: folder, query: '', limit })
        .then((result) => {
          pageCache.set(key, result)
          writeDisk(`page.${key}`, result)
        })
        .catch(() => undefined)
    }, 180)
    folderPrefetchTimers.current.push(timer)
  }

  const openMessage = async (item: MessageSummary): Promise<void> => {
    const owner = item.accountId
    const ownerSource = source
    const cacheKey = messageKeyOf(item)
    const cached = detailCache.get(cacheKey)
    setError('')
    if (cached !== undefined && Date.now() - cached.at < DETAIL_TTL) {
      setSelected(cached.detail)
    } else {
      setOpening(item.subject)
    }
    try {
      const detail =
        cached !== undefined && Date.now() - cached.at < DETAIL_TTL
          ? cached.detail
          : await api.message({ id: item.id, accountId: owner, source: ownerSource, mailbox })
      detailCache.set(cacheKey, { at: Date.now(), detail })
      setSelected(detail)
      setOpening(null)
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
      setOpening(null)
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

  const requestAi = (kind: AiRequest['kind']): void => {
    setRailOpen(true)
    setAiRequest({ kind, nonce: Date.now() })
  }

  const insertReply = (init: AiReplyInit): void => {
    if (selected === null) return
    setCompose({
      mode: 'reply',
      accountId: selected.accountId,
      to: init.to,
      cc: init.cc,
      bcc: '',
      subject: init.subject,
      html: init.html,
      ...(init.inReplyTo === undefined ? {} : { inReplyTo: init.inReplyTo }),
      ...(init.references === undefined ? {} : { references: init.references }),
    })
  }

  const saveReplyDraft = async (init: AiReplyInit): Promise<void> => {
    if (selected === null) return
    try {
      await api.saveDraft(selected.accountId, {
        to: init.to,
        cc: init.cc,
        bcc: '',
        subject: init.subject,
        html: init.html,
        attachments: [],
        ...(init.inReplyTo === undefined ? {} : { inReplyTo: init.inReplyTo }),
        ...(init.references === undefined ? {} : { references: init.references }),
      })
      notice('已存为草稿')
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
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

  if (state === null) {
    return h(
      'div',
      { className: 'mailharbor' },
      h('div', { className: 'mailharbor-settings' }, '正在读取邮箱…'),
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

  const loadDetailFor = async (item: MessageSummary): Promise<MessageDetail> => {
    const key = messageKeyOf(item)
    const cached = detailCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < DETAIL_TTL) return cached.detail
    const detail = await api.message({
      id: item.id,
      accountId: item.accountId,
      source,
      mailbox,
    })
    detailCache.set(key, { at: Date.now(), detail })
    return detail
  }

  const threadItems =
    selected === null
      ? []
      : items.filter(
          (item) =>
            item.accountId === selected.accountId &&
            normalizeSubject(item.subject) === normalizeSubject(selected.subject),
        )

  const isSent = isSentFolder(mailbox)
  const groups = groupMessages(items)

  const renderMessage = (
    item: MessageSummary,
    meta: { compact?: boolean; groupCount?: number; groupKey?: string; expanded?: boolean } = {},
  ): ReactNode => {
    const sent = isSent && item.to.length > 0
    const first = sent ? item.to[0] : item.from
    const who = first === undefined || first === null ? '' : first.name !== '' ? first.name : first.address
    const extra = sent && item.to.length > 1 ? ` +${String(item.to.length - 1)}` : ''
    const isSelected = selected?.id === item.id && selected?.accountId === item.accountId
    return h(
      'div',
      {
        key: `${item.accountId}:${item.id}`,
        className: `mailharbor-row${item.unread ? ' unread' : ''}${isSelected ? ' selected' : ''}${selectMode ? ' selectable' : ''}${meta.compact === true ? ' compact' : ''}`,
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          if (selectMode) toggleSelect(item)
          else void openMessage(item)
        },
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (selectMode) toggleSelect(item)
            else void openMessage(item)
          }
        },
        onMouseEnter: () => {
          if (!selectMode) prefetchMessage(item)
        },
        onMouseLeave: () => {
          if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
        },
      },
      h(
        'span',
        { className: 'line-1' },
        selectMode
          ? h('input', {
              type: 'checkbox',
              checked: selectedKeys.includes(`${item.accountId}:${item.id}`),
              'aria-label': '选择邮件',
              onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
              onChange: () => toggleSelect(item),
            })
          : item.unread
            ? h('span', { className: 'dot' })
            : null,
        sent ? h('span', { className: 'to-label' }, '收件人 ') : null,
        h('span', { className: 'from' }, `${who}${extra}`),
        item.hasAttachments ? h(Icon, { name: 'paperclip', size: 13 }) : null,
        source === 'local' && item.backedUp === false
          ? h('span', { className: 'badge warn' }, '未备份')
          : null,
        meta.groupCount !== undefined && meta.groupCount > 1
          ? h(
              'button',
              {
                className: 'thread-count',
                title: meta.expanded === true ? '收起会话' : `展开会话（${String(meta.groupCount)} 封）`,
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  toggleGroup(meta.groupKey ?? '')
                },
              },
              meta.expanded === true ? '−' : String(meta.groupCount),
            )
          : null,
        h('span', { className: 'date' }, shortDate(item.date)),
      ),
      meta.compact === true
        ? null
        : h('span', { className: 'line-2' }, h('span', { className: 'subject' }, item.subject)),
      item.snippet === '' ? null : h('span', { className: 'snippet' }, item.snippet),
    )
  }

  return h(
    'div',
    { className: narrow ? 'mailharbor mailharbor-narrow' : 'mailharbor' },
    h(
      'div',
      { className: 'mailharbor-topbar' },
      h(
        'button',
        {
          className: 'mailharbor-account',
          onClick: toggleSide,
          title: sideOpen ? '收起账号与文件夹' : '展开账号与文件夹',
        },
        h(Avatar, { email: currentAccount?.email ?? '?', size: 26 }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('span', { className: 'name' }, currentAccount?.label ?? ''),
          h('span', { className: 'small muted' }, currentAccount?.email ?? ''),
        ),
        state.loggedIn === false ? h('span', { className: 'badge warn' }, '未登录') : null,
        h(Icon, { name: sideOpen ? 'chevronLeft' : 'chevronRight', size: 14 }),
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
        { className: 'ghost', onClick: openManager, title: '项目管理' },
        h(Icon, { name: 'folder' }),
        '项目',
      ),
      h(
        'button',
        {
          className: railOpen ? 'ghost active' : 'ghost',
          onClick: () => setRailOpen(!railOpen),
          title: 'AI 工作台',
        },
        h(Icon, { name: 'sparkles' }),
        'AI',
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
          sideOpen
            ? h(
                'aside',
                { className: 'mailharbor-side' },
                h('div', { className: 'mailharbor-side-section' }, '账号'),
                accounts.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: `mailharbor-side-item${!isAll && item.id === accountScope ? ' active' : ''}`,
                      onClick: () => {
                        void switchAccount(item.id)
                        setSource('server')
                        setMailbox('INBOX')
                      },
                    },
                    h(Avatar, { email: item.email, size: 18 }),
                    h(
                      'span',
                      { className: 'name' },
                      h('span', null, item.label),
                      h('span', { className: 'sub' }, item.email),
                    ),
                    item.enabled === false ? h('span', { className: 'badge warn' }, '停用') : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'mailharbor-side-section' },
                  source === 'server' ? '服务器文件夹' : '本地文件夹',
                ),
                folders.map((folder) =>
                  h(
                    'button',
                    {
                      key: folder.name,
                      className: `mailharbor-side-item${mailbox === folder.name ? ' active' : ''}`,
                      onClick: () => {
                        setMailbox(folder.name)
                        setSelected(null)
                      },
                      onMouseEnter: () => prefetchFolder(folder.name),
                    },
                    h(Icon, { name: folder.name === DRAFTS ? 'compose' : 'folder', size: 14 }),
                    h('span', { className: 'name' }, folderName(folder.label ?? folder.name)),
                    folder.count > 0 ? h('span', { className: 'count' }, String(folder.count)) : null,
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'mailharbor-list' },
            h(
              'div',
              { className: 'mailharbor-filters' },
              h('input', {
                type: 'search',
                placeholder: showingDrafts
                  ? '搜索草稿'
                  : aiSearching
                    ? 'AI 正在理解你的搜索…'
                    : '搜索邮件，或描述你要找什么（AI）',
                'aria-label': '搜索邮件',
                value: query,
                onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
                onKeyDown: (event: { key: string }) => {
                  if (event.key === 'Enter') {
                    if (showingDrafts) setSearch(query)
                    else void runAiSearch()
                  }
                  if (event.key === 'Escape') {
                    setQuery('')
                    setSearch('')
                    setAiInfo(null)
                  }
                },
              }),
              h(
                'button',
                {
                  className: selectMode ? 'ghost active' : 'ghost',
                  title: '选择多封邮件加入项目',
                  onClick: () => {
                    if (selectMode) {
                      setSelectMode(false)
                      setSelectedKeys([])
                    } else {
                      void enterSelect()
                    }
                  },
                },
                Icon({ name: 'list', size: 14 }),
                '选择',
              ),
              query !== search || search !== ''
                ? h(
                    'button',
                    {
                      className: 'subtle',
                      title: '清除搜索',
                      onClick: () => {
                        setQuery('')
                        setSearch('')
                        setAiInfo(null)
                      },
                    },
                    h(Icon, { name: 'close', size: 14 }),
                  )
                : null,
            ),
            aiInfo === null
              ? null
              : h(
                  'div',
                  { className: 'mailharbor-ai-search' },
                  h(Icon, { name: 'sparkles', size: 13 }),
                  h(
                    'span',
                    null,
                    aiInfo.explanation !== '' ? aiInfo.explanation : `关键词：${aiInfo.keywords.join('、')}`,
                  ),
                  h('span', { className: 'spacer' }),
                  h(
                    'button',
                    {
                      className: 'subtle',
                      onClick: () => {
                        setAiInfo(null)
                        setTick((value) => value + 1)
                      },
                    },
                    '清除',
                  ),
                ),
            aiSearching
              ? h(
                  'div',
                  { className: 'mailharbor-ai-search searching' },
                  h('span', { className: 'mailharbor-spinner' }),
                  `AI 正在理解并搜索… ${String(aiElapsed)}s`,
                )
              : null,
            selectMode
              ? h(
                  'div',
                  { className: 'mailharbor-selectbar' },
                  h('span', { className: 'small' }, `已选 ${String(selectedKeys.length)} 封`),
                  h('span', { className: 'spacer' }),
                  h(
                    'select',
                    {
                      value: targetProject,
                      onChange: (event: { target: { value: string } }) =>
                        setTargetProject(event.target.value),
                      'aria-label': '目标项目',
                    },
                    h('option', { value: '' }, projectOptions.length === 0 ? '还没有项目' : '选择项目'),
                    projectOptions.map((project) =>
                      h('option', { key: project.id, value: project.id }, project.name),
                    ),
                  ),
                  h(
                    'button',
                    {
                      className: 'primary',
                      disabled: selectedKeys.length === 0 || targetProject === '',
                      onClick: () => void addSelectedToProject(),
                    },
                    '加入项目',
                  ),
                  h(
                    'button',
                    {
                      className: 'ghost',
                      onClick: () => {
                        setSelectMode(false)
                        setSelectedKeys([])
                      },
                    },
                    '取消',
                  ),
                )
              : null,
            loading && items.length > 0 && !showingDrafts
              ? h(
                  'div',
                  { className: 'mailharbor-refreshing' },
                  h('span', { className: 'mailharbor-spinner' }),
                  '正在刷新…',
                )
              : null,
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
                        h(Icon, { name: aiInfo === null ? 'mail' : 'sparkles', size: 28 }),
                        h(
                          'div',
                          { className: 'title' },
                          aiInfo === null
                            ? source === 'local'
                              ? '本地备份里还没有邮件'
                              : '服务器上没有邮件'
                            : 'AI 搜索没有找到匹配邮件',
                        ),
                        h(
                          'div',
                          { className: 'small' },
                          aiInfo === null
                            ? source === 'local'
                              ? '点顶部「备份」把服务器邮件同步下来。'
                              : '换一个文件夹或稍后刷新。'
                            : '换个说法，或直接输入关键词后按回车。',
                        ),
                      )
                    : selectMode
                      ? items.map((item) => renderMessage(item))
                      : groups.map((group) => {
                          const latest = group.items[0]
                          if (latest === undefined) return null
                          const expanded = expandedGroups.includes(group.key)
                          return h(
                            'div',
                            { className: 'mailharbor-thread', key: group.key },
                            renderMessage(latest, {
                              groupCount: group.items.length,
                              groupKey: group.key,
                              expanded,
                            }),
                            expanded
                              ? group.items.slice(1).map((item) => renderMessage(item, { compact: true }))
                              : null,
                          )
                        }),
            ),
            !showingDrafts && items.length > 0
              ? h(
                  'div',
                  { className: 'mailharbor-list-foot' },
                  h('span', null, `${String(items.length)} / ${String(page.total)} 封`),
                  h('span', { className: 'spacer' }),
                  page.total > items.length && aiInfo === null
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
              : opening !== null && selected === null
                ? h(
                    'div',
                    { className: 'mailharbor-reader' },
                    h(
                      'div',
                      { className: 'mailharbor-reader-head' },
                      h(
                        'div',
                        { className: 'mailharbor-reader-title' },
                        h('h2', null, opening),
                        h('span', { className: 'mailharbor-spinner', style: { marginLeft: '8px' } }),
                      ),
                      h('div', { className: 'small muted' }, '正在读取邮件…'),
                    ),
                  )
                : h(Reader, {
                    detail: selected,
                    source,
                    mailbox,
                    onChanged: (patch) => setSelected({ ...selected, ...patch }),
                    onReply: (mode) => startCompose(mode),
                    onAiAction: requestAi,
                    onExtractTasks: () => void extractTasks(),
                    onAddToProject: openProjectPicker,
                    onClose: narrow ? () => setSelected(null) : undefined,
                    thread: threadItems,
                    onSelectMessage: (item) => void openMessage(item),
                    loadDetail: loadDetailFor,
                  }),
          ),
          railOpen
            ? h(AiRail, {
                account:
                  accounts.find((item) => item.id === (selected?.accountId ?? accountScope)) ??
                  currentAccount,
                detail: selected,
                source,
                mailbox,
                request: aiRequest,
                onClose: () => setRailOpen(false),
                onInsert: insertReply,
                onSaveDraft: (init) => void saveReplyDraft(init),
                onNotice: notice,
              })
            : null,
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
    managerOpen
      ? h(
          Modal,
          {
            title: '项目管理',
            onClose: () => setManagerOpen(false),
            wide: true,
            footer: h(
              'div',
              { className: 'task-editor-foot' },
              h(
                'span',
                { className: 'small muted' },
                '删除只移除 MailHarbor 的项目记录，文件夹与 DSH 工作空间会保留。',
              ),
              h('span', { className: 'spacer' }),
              h('button', { className: 'ghost', onClick: () => setManagerOpen(false) }, '关闭'),
            ),
          },
          managerProjects.length === 0
            ? h(
                'p',
                { className: 'small muted' },
                '还没有项目。可以从一封邮件的「加入项目 → 新建项目」开始。',
              )
            : h(
                'div',
                { className: 'project-manager' },
                managerProjects.map((project) =>
                  h(
                    'div',
                    { key: project.id, className: 'project-manager-row' },
                    h(
                      'div',
                      { className: 'project-manager-main' },
                      managerRename?.id === project.id
                        ? h('input', {
                            value: managerRename.name,
                            autoFocus: true,
                            onChange: (event: { target: { value: string } }) =>
                              setManagerRename({ id: project.id, name: event.target.value }),
                            onKeyDown: (event: { key: string }) => {
                              if (event.key === 'Enter' && managerRename.name.trim() !== '') {
                                void managerAction(() =>
                                  api.updateProject(project.id, managerRename.name.trim()),
                                )
                              }
                            },
                          })
                        : h('strong', null, project.name),
                      h(
                        'span',
                        { className: 'small muted' },
                        `${String(project.messages.length)} 封来源邮件 · ${project.path}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'project-manager-actions' },
                      managerRename?.id === project.id
                        ? h(
                            'button',
                            {
                              className: 'primary small',
                              disabled: managerBusy || managerRename.name.trim() === '',
                              onClick: () =>
                                void managerAction(() =>
                                  api.updateProject(project.id, managerRename.name.trim()),
                                ),
                            },
                            '保存名称',
                          )
                        : h(
                            'button',
                            {
                              className: 'ghost small',
                              onClick: () => setManagerRename({ id: project.id, name: project.name }),
                            },
                            '重命名',
                          ),
                      h(
                        'button',
                        {
                          className: 'ghost small',
                          onClick: () => {
                            void api
                              .openProject(project.id)
                              .catch((caught: unknown) => setError(errorText(caught)))
                          },
                        },
                        '打开文件夹',
                      ),
                      managerConfirm === project.id
                        ? h(
                            'span',
                            { style: { display: 'inline-flex', gap: '6px' } },
                            h(
                              'button',
                              {
                                className: 'ghost small danger',
                                disabled: managerBusy,
                                onClick: () =>
                                  void managerAction(async () => {
                                    await api.deleteProject(project.id)
                                    notice('项目已删除（文件夹保留）')
                                  }),
                              },
                              '确认删除',
                            ),
                            h(
                              'button',
                              { className: 'ghost small', onClick: () => setManagerConfirm('') },
                              '取消',
                            ),
                          )
                        : h(
                            'button',
                            {
                              className: 'ghost small danger',
                              onClick: () => setManagerConfirm(project.id),
                            },
                            '删除',
                          ),
                    ),
                  ),
                ),
              ),
        )
      : null,
    projectPicker !== null
      ? h(
          Modal,
          {
            title: '加入项目',
            onClose: () => setProjectPicker(null),
            footer: h(
              'div',
              { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } },
              h('button', { className: 'subtle', onClick: openManager }, '管理项目…'),
              h('span', { className: 'spacer' }),
              h('button', { className: 'ghost', onClick: () => setProjectPicker(null) }, '取消'),
              h(
                'button',
                { className: 'primary', disabled: pickerBusy, onClick: () => void saveProjectPick() },
                pickerBusy ? '保存中…' : pickerMode === 'new' ? '创建并加入' : '加入项目',
              ),
            ),
          },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            h(
              'div',
              { className: 'mailharbor-segment', role: 'tablist' },
              h(
                'button',
                {
                  className: pickerMode === 'existing' ? 'active' : '',
                  disabled: pickerProjects.length === 0,
                  onClick: () => setPickerMode('existing'),
                },
                '加入已有项目',
              ),
              h(
                'button',
                {
                  className: pickerMode === 'new' ? 'active' : '',
                  onClick: () => setPickerMode('new'),
                },
                '新建项目',
              ),
            ),
            pickerMode === 'existing'
              ? h(
                  'div',
                  { className: 'mailharbor-field' },
                  h('label', null, '项目'),
                  h(
                    'select',
                    {
                      value: pickerTarget,
                      onChange: (event: { target: { value: string } }) => setPickerTarget(event.target.value),
                    },
                    pickerProjects.map((project) =>
                      h(
                        'option',
                        { key: project.id, value: project.id },
                        `${project.name} · ${project.messages.length} 封`,
                      ),
                    ),
                  ),
                  h('p', { className: 'small muted' }, '只会把当前邮件加入这个项目，不会新建项目。'),
                )
              : h(
                  'div',
                  { className: 'mailharbor-field' },
                  h('label', null, '新项目名称'),
                  h('input', {
                    value: pickerNewName,
                    placeholder: '项目名称',
                    onChange: (event: { target: { value: string } }) => setPickerNewName(event.target.value),
                  }),
                  h(
                    'p',
                    { className: 'small muted' },
                    '会创建新的项目文件夹，并把当前邮件作为第一封来源邮件。',
                  ),
                ),
            h('p', { className: 'small muted' }, `来源邮件：${projectPicker.subject}`),
          ),
        )
      : null,
    extraction !== null
      ? h(
          Modal,
          {
            title: '提取任务',
            onClose: () => setExtraction(null),
            footer: h(
              'div',
              { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } },
              h('span', { className: 'small muted' }, '勾选要保存的任务；保存后可到「任务」面板跟进。'),
              h('span', { className: 'spacer' }),
              h('button', { className: 'ghost', onClick: () => setExtraction(null) }, '取消'),
              h(
                'button',
                {
                  className: 'primary',
                  disabled: extractBusy || extraction.checked.every((value) => !value),
                  onClick: () => void saveExtraction(),
                },
                extractBusy ? '保存中…' : '保存任务',
              ),
            ),
          },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            extraction.items.map((item, index) =>
              h(
                'div',
                { key: `${item.title}:${String(index)}`, className: 'mailharbor-extract-row' },
                h('input', {
                  type: 'checkbox',
                  checked: extraction.checked[index] ?? false,
                  onChange: () => {
                    const checked = [...extraction.checked]
                    checked[index] = !checked[index]
                    setExtraction({ ...extraction, checked })
                  },
                }),
                h(
                  'div',
                  { className: 'extract-body' },
                  h('input', {
                    className: 'extract-title',
                    value: item.title,
                    onChange: (event: { target: { value: string } }) =>
                      updateSuggestion(index, { title: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'extract-meta' },
                    h('input', {
                      type: 'date',
                      value: item.due,
                      onChange: (event: { target: { value: string } }) =>
                        updateSuggestion(index, { due: event.target.value }),
                    }),
                    h(
                      'select',
                      {
                        value: String(item.priority),
                        onChange: (event: { target: { value: string } }) =>
                          updateSuggestion(index, { priority: Number(event.target.value) }),
                      },
                      h('option', { value: '0' }, '无优先级'),
                      h('option', { value: '3' }, '低'),
                      h('option', { value: '5' }, '中'),
                      h('option', { value: '9' }, '高'),
                    ),
                    h('input', {
                      className: 'extract-owner',
                      value: item.owner,
                      placeholder: '这个事联系谁',
                      onChange: (event: { target: { value: string } }) =>
                        updateSuggestion(index, { owner: event.target.value }),
                    }),
                  ),
                  item.notes === '' ? null : h('span', { className: 'small muted' }, item.notes),
                ),
                h(
                  'button',
                  {
                    className: 'subtle icon',
                    title: '移除这条',
                    onClick: () => removeSuggestion(index),
                  },
                  h(Icon, { name: 'close', size: 12 }),
                ),
              ),
            ),
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
