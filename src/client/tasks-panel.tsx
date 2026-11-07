import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, Project, Task } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { ErrorBar, Modal } from './components.js'
import { Icon } from './icons.js'
import { requestOpenMail } from './nav.js'

type Filter = 'open' | 'today' | 'week' | 'overdue' | 'done' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: '待办' },
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'overdue', label: '逾期' },
  { id: 'done', label: '已完成' },
  { id: 'all', label: '全部' },
]

const STATUS_LABEL: Record<string, string> = {
  'NEEDS-ACTION': '待处理',
  'IN-PROCESS': '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function dateKey(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(value.getFullYear())}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function weekEnd(): string {
  const now = new Date()
  const end = new Date(now)
  end.setDate(now.getDate() + (7 - ((now.getDay() + 6) % 7)))
  return dateKey(end)
}

function dueText(due: string): string {
  if (due === '') return ''
  const today = dateKey(new Date())
  if (due.slice(0, 10) < today) return `逾期 ${due.slice(0, 10)}`
  return due.slice(0, 10)
}

const EMPTY_TASK = {
  title: '',
  notes: '',
  due: '',
  priority: 0,
  status: 'NEEDS-ACTION',
  owner: '',
  projectId: '',
}

export function TasksIcon(): ReactNode {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const app = await api.state()
        const accountId = app.settings.activeAccountId
        if (accountId === null) return
        const result = await api.tasks(accountId)
        if (!cancelled) {
          setCount(
            result.items.filter((task) => task.status !== 'COMPLETED' && task.status !== 'CANCELLED').length,
          )
        }
      } catch {
        // A logged-out profile simply shows no badge.
      }
    }
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return h(
    'span',
    {
      style: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
      },
    },
    h(Icon, { name: 'checklist', size: 16 }),
    count > 0
      ? h(
          'span',
          {
            style: {
              position: 'absolute',
              right: '-5px',
              bottom: '-3px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              minWidth: '13px',
              height: '13px',
              padding: '0 3px',
              borderRadius: '999px',
              background: '#5686fe',
              color: '#fff',
              fontSize: '9px',
              fontWeight: 600,
              lineHeight: '13px',
              boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #151517)',
              pointerEvents: 'none',
            },
          },
          count > 99 ? '99+' : String(count),
        )
      : null,
  )
}

export function TasksPanel(): ReactNode {
  const [state, setState] = useState<AppState | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [calendar, setCalendar] = useState<{ lastSync: string; error: string } | null>(null)
  const [filter, setFilter] = useState<Filter>('open')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  const [tick, setTick] = useState(0)

  const accountId = state?.settings.activeAccountId ?? null

  useEffect(() => {
    api
      .state()
      .then(setState)
      .catch((caught: unknown) => setError(errorText(caught)))
  }, [tick])

  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    Promise.all([api.tasks(accountId), api.projects()])
      .then(([list, projectList]) => {
        if (cancelled) return
        setTasks(list.items)
        setCalendar(list.calendar)
        setProjects(projectList.items)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
    return () => {
      cancelled = true
    }
  }, [accountId, tick])

  const refresh = useCallback((): void => {
    setTick((value) => value + 1)
  }, [])

  const notify = (message: string): void => {
    setToast(message)
    window.setTimeout(() => {
      setToast('')
    }, 3000)
  }

  const visible = useMemo(() => {
    const today = dateKey(new Date())
    const end = weekEnd()
    return tasks.filter((task) => {
      const done = task.status === 'COMPLETED' || task.status === 'CANCELLED'
      if (filter === 'done') return done
      if (done) return false
      if (filter === 'all') return true
      if (filter === 'overdue') return task.due !== '' && task.due.slice(0, 10) < today
      if (filter === 'today') return task.due.slice(0, 10) === today
      if (filter === 'week') return task.due !== '' && task.due.slice(0, 10) <= end
      return true
    })
  }, [tasks, filter])

  const open = tasks.filter((task) => task.status !== 'COMPLETED' && task.status !== 'CANCELLED')
  const done = tasks.length - open.length
  const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)

  const byProject = useMemo(() => {
    const groups = new Map<string, { project: Project | null; total: number; done: number }>()
    for (const task of tasks) {
      const key = task.projectId ?? ''
      const group = groups.get(key) ?? {
        project: projects.find((project) => project.id === key) ?? null,
        total: 0,
        done: 0,
      }
      group.total += 1
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') group.done += 1
      groups.set(key, group)
    }
    return [...groups.values()].filter((group) => group.project !== null)
  }, [tasks, projects])

  const switchAccount = async (id: string): Promise<void> => {
    try {
      await api.activateAccount(id)
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const toggle = async (task: Task): Promise<void> => {
    try {
      const next = task.status === 'COMPLETED' ? 'NEEDS-ACTION' : 'COMPLETED'
      const { task: updated } = await api.updateTask(task.id, { status: next })
      setTasks((current) => current.map((item) => (item.id === task.id ? updated : item)))
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const remove = async (task: Task): Promise<void> => {
    try {
      await api.deleteTask(task.id)
      setTasks((current) => current.filter((item) => item.id !== task.id))
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const openSource = async (task: Task): Promise<void> => {
    if (task.messageKey === '') return
    try {
      const found = await api.lookupMessage(task.accountId, task.messageKey)
      requestOpenMail({ accountId: task.accountId, id: found.id, mailbox: found.mailbox })
      // Best effort: switch to the mail panel; the pending request opens the mail.
      document.querySelector<HTMLElement>('button[aria-label="MailHarbor"]')?.click()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const sync = async (): Promise<void> => {
    if (accountId === null) return
    setBusy(true)
    setError('')
    try {
      const result = await api.syncTasks(accountId)
      notify(`已同步：拉取 ${String(result.result.pulled)}，推送 ${String(result.result.pushed)}`)
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const save = async (draft: typeof EMPTY_TASK & { id?: string }): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (draft.id === undefined) {
        await api.createTask({
          accountId,
          title: draft.title,
          notes: draft.notes,
          due: draft.due,
          priority: draft.priority,
          status: draft.status,
          owner: draft.owner,
          projectId: draft.projectId === '' ? null : draft.projectId,
        })
      } else {
        await api.updateTask(draft.id, {
          title: draft.title,
          notes: draft.notes,
          due: draft.due,
          priority: draft.priority,
          status: draft.status,
          owner: draft.owner,
          projectId: draft.projectId === '' ? null : draft.projectId,
        })
      }
      setEditing(null)
      setCreating(false)
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'mailharbor' },
    h(
      'div',
      { className: 'mailharbor-topbar' },
      h(Icon, { name: 'checklist', size: 16 }),
      h('strong', { style: { fontSize: '13px' } }, '任务'),
      state === null || state.accounts.length < 2
        ? null
        : h(
            'select',
            {
              value: accountId ?? '',
              onChange: (event: { target: { value: string } }) => void switchAccount(event.target.value),
              'aria-label': '账号',
            },
            state.accounts.map((account) =>
              h('option', { key: account.id, value: account.id }, account.label),
            ),
          ),
      h('span', { className: 'spacer' }),
      calendar === null
        ? null
        : h(
            'span',
            { className: 'small muted' },
            calendar.lastSync === '' ? '未同步' : `同步于 ${new Date(calendar.lastSync).toLocaleString()}`,
          ),
      h(
        'button',
        { className: 'ghost', onClick: () => void sync(), disabled: busy },
        busy ? '同步中…' : '同步 CalDAV',
      ),
      h(
        'button',
        { className: 'primary', onClick: () => setCreating(true) },
        h(Icon, { name: 'plus' }),
        '新建任务',
      ),
    ),
    toast === ''
      ? null
      : h('div', { className: 'small', style: { padding: '6px 14px', color: 'var(--m-ok)' } }, toast),
    error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),
    h(
      'div',
      { className: 'tasks-body' },
      h(
        'div',
        { className: 'tasks-overview' },
        h(
          'div',
          { className: 'tasks-progress' },
          h(
            'div',
            { className: 'tasks-progress-head' },
            h('strong', null, '总体进度'),
            h(
              'span',
              { className: 'muted small' },
              `${String(done)} / ${String(tasks.length)} · ${String(progress)}%`,
            ),
          ),
          h('div', { className: 'tasks-bar' }, h('span', { style: { width: `${String(progress)}%` } })),
          h('div', { className: 'small muted' }, `待办 ${String(open.length)} 条`),
        ),
        ...byProject.map((group) =>
          h(
            'div',
            { key: group.project?.id ?? 'none', className: 'tasks-project' },
            h(
              'div',
              { className: 'tasks-project-head' },
              h('span', { className: 'name' }, group.project?.name ?? ''),
              h('span', { className: 'muted small' }, `${String(group.done)}/${String(group.total)}`),
            ),
            h(
              'div',
              { className: 'tasks-bar small' },
              h('span', {
                style: {
                  width: `${String(group.total === 0 ? 0 : Math.round((group.done / group.total) * 100))}%`,
                },
              }),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'tasks-list-wrap' },
        h(
          'div',
          { className: 'tasks-filters' },
          FILTERS.map((item) =>
            h(
              'button',
              {
                key: item.id,
                className: filter === item.id ? 'chip active' : 'chip',
                onClick: () => setFilter(item.id),
              },
              item.label,
            ),
          ),
        ),
        visible.length === 0
          ? h(
              'div',
              { className: 'mailharbor-empty' },
              h(Icon, { name: 'checklist', size: 28 }),
              h('div', { className: 'title' }, '没有任务'),
              h('div', { className: 'small' }, '可以在这里新建，或在邮件里用「提取任务」。'),
            )
          : h(
              'div',
              { className: 'tasks-list' },
              visible.map((task) =>
                h(
                  'div',
                  { key: task.id, className: `tasks-row${task.status === 'COMPLETED' ? ' done' : ''}` },
                  h('input', {
                    type: 'checkbox',
                    checked: task.status === 'COMPLETED',
                    'aria-label': '完成任务',
                    onChange: () => void toggle(task),
                  }),
                  h(
                    'button',
                    { className: 'tasks-title', onClick: () => setEditing(task) },
                    h('span', null, task.title),
                    h(
                      'span',
                      { className: 'tasks-meta' },
                      task.due === ''
                        ? null
                        : h(
                            'span',
                            {
                              className: task.due.slice(0, 10) < dateKey(new Date()) ? 'due overdue' : 'due',
                            },
                            dueText(task.due),
                          ),
                      task.owner === '' ? null : h('span', null, task.owner),
                      h('span', { className: 'badge' }, STATUS_LABEL[task.status] ?? task.status),
                      task.projectId === null
                        ? null
                        : h(
                            'span',
                            { className: 'badge' },
                            projects.find((project) => project.id === task.projectId)?.name ?? '项目',
                          ),
                    ),
                  ),
                  task.messageKey === ''
                    ? null
                    : h(
                        'button',
                        {
                          className: 'subtle small',
                          title: '打开来源邮件',
                          onClick: () => void openSource(task),
                        },
                        '来源',
                      ),
                  h(
                    'button',
                    { className: 'subtle icon', title: '删除', onClick: () => void remove(task) },
                    h(Icon, { name: 'trash', size: 13 }),
                  ),
                ),
              ),
            ),
      ),
    ),
    creating || editing !== null
      ? h(TaskEditor, {
          task: editing,
          projects,
          busy,
          onClose: () => {
            setCreating(false)
            setEditing(null)
          },
          onSave: (draft) => void save(draft),
        })
      : null,
  )
}

function TaskEditor({
  task,
  projects,
  busy,
  onClose,
  onSave,
}: {
  task: Task | null
  projects: Project[]
  busy: boolean
  onClose: () => void
  onSave: (draft: typeof EMPTY_TASK & { id?: string }) => void
}): ReactNode {
  const [draft, setDraft] = useState({
    ...EMPTY_TASK,
    ...(task === null
      ? {}
      : {
          id: task.id,
          title: task.title,
          notes: task.notes,
          due: task.due.slice(0, 10),
          priority: task.priority,
          status: task.status,
          owner: task.owner,
          projectId: task.projectId ?? '',
        }),
  })
  const set = (patch: Partial<typeof draft>): void => setDraft((current) => ({ ...current, ...patch }))

  return h(
    Modal,
    {
      title: task === null ? '新建任务' : '编辑任务',
      onClose,
      footer: h(
        'div',
        { style: { display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end' } },
        h('button', { className: 'ghost', onClick: onClose }, '取消'),
        h(
          'button',
          { className: 'primary', disabled: busy || draft.title.trim() === '', onClick: () => onSave(draft) },
          busy ? '保存中…' : '保存',
        ),
      ),
    },
    h(
      'div',
      { className: 'mailharbor-field' },
      h('label', null, '标题'),
      h('input', {
        value: draft.title,
        autoFocus: true,
        onChange: (event: { target: { value: string } }) => set({ title: event.target.value }),
      }),
    ),
    h(
      'div',
      { className: 'mailharbor-field' },
      h('label', null, '备注'),
      h('textarea', {
        rows: 3,
        value: draft.notes,
        onChange: (event: { target: { value: string } }) => set({ notes: event.target.value }),
      }),
    ),
    h(
      'div',
      { className: 'mailharbor-grid' },
      h(
        'div',
        { className: 'mailharbor-field' },
        h('label', null, '截止日期'),
        h('input', {
          type: 'date',
          value: draft.due,
          onChange: (event: { target: { value: string } }) => set({ due: event.target.value }),
        }),
      ),
      h(
        'div',
        { className: 'mailharbor-field' },
        h('label', null, '优先级'),
        h(
          'select',
          {
            value: String(draft.priority),
            onChange: (event: { target: { value: string } }) => set({ priority: Number(event.target.value) }),
          },
          h('option', { value: '0' }, '无'),
          h('option', { value: '5' }, '中'),
          h('option', { value: '9' }, '高'),
        ),
      ),
    ),
    h(
      'div',
      { className: 'mailharbor-grid' },
      h(
        'div',
        { className: 'mailharbor-field' },
        h('label', null, '状态'),
        h(
          'select',
          {
            value: draft.status,
            onChange: (event: { target: { value: string } }) => set({ status: event.target.value }),
          },
          Object.entries(STATUS_LABEL).map(([value, label]) => h('option', { key: value, value }, label)),
        ),
      ),
      h(
        'div',
        { className: 'mailharbor-field' },
        h('label', null, '项目'),
        h(
          'select',
          {
            value: draft.projectId,
            onChange: (event: { target: { value: string } }) => set({ projectId: event.target.value }),
          },
          h('option', { value: '' }, '无项目'),
          projects.map((project) => h('option', { key: project.id, value: project.id }, project.name)),
        ),
      ),
    ),
    h(
      'div',
      { className: 'mailharbor-field' },
      h('label', null, '负责人'),
      h('input', {
        value: draft.owner,
        onChange: (event: { target: { value: string } }) => set({ owner: event.target.value }),
      }),
    ),
  )
}
