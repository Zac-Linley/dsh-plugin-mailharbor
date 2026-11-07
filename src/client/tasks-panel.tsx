import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AppState, Project, Task } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { ErrorBar, Modal } from './components.js'
import { Icon } from './icons.js'
import { requestOpenMail } from './nav.js'

type Filter = 'all' | 'today' | 'week' | 'overdue'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'overdue', label: '逾期' },
]

const COLUMNS: { status: Task['status']; label: string; hint: string }[] = [
  { status: 'NEEDS-ACTION', label: '待处理', hint: '还没开始' },
  { status: 'IN-PROCESS', label: '进行中', hint: '正在做' },
  { status: 'COMPLETED', label: '已完成', hint: '收尾' },
  { status: 'CANCELLED', label: '终止', hint: '不做了' },
]

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 5: '中', 9: '高' }

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
  const value = due.slice(0, 10)
  const today = dateKey(new Date())
  if (value < today) return `逾期 ${value}`
  if (value === today) return '今天'
  return value
}

const EMPTY = {
  title: '',
  notes: '',
  due: '',
  priority: 0,
  status: 'NEEDS-ACTION' as Task['status'],
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
  const [filter, setFilter] = useState<Filter>('all')
  const [projectFilter, setProjectFilter] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState<Task['status'] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
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

  const matchesFilter = useCallback(
    (task: Task): boolean => {
      const today = dateKey(new Date())
      const end = weekEnd()
      if (filter === 'overdue') return task.due !== '' && task.due.slice(0, 10) < today
      if (filter === 'today') return task.due.slice(0, 10) === today
      if (filter === 'week') return task.due !== '' && task.due.slice(0, 10) <= end
      return true
    },
    [filter],
  )

  const switchAccount = async (id: string): Promise<void> => {
    try {
      await api.activateAccount(id)
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const move = async (task: Task, status: Task['status']): Promise<void> => {
    if (task.status === status) return
    try {
      const { task: updated } = await api.updateTask(task.id, { status })
      setTasks((current) => current.map((item) => (item.id === task.id ? updated : item)))
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const remove = async (task: Task): Promise<void> => {
    try {
      await api.deleteTask(task.id)
      setTasks((current) => current.filter((item) => item.id !== task.id))
      notify('任务已删除')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const openSource = async (task: Task): Promise<void> => {
    if (task.messageKey === '') return
    try {
      const found = await api.lookupMessage(task.accountId, task.messageKey)
      requestOpenMail({ accountId: task.accountId, id: found.id, mailbox: found.mailbox })
      document.querySelector<HTMLElement>('button[aria-label="MailHarbor"]')?.click()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const save = async (draft: typeof EMPTY & { id?: string }): Promise<void> => {
    if (accountId === null) return
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
      setCreating(null)
      notify('任务已保存')
      refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'mailharbor mailharbor-tasks' },
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
      h(
        'button',
        { className: 'primary', onClick: () => setCreating('NEEDS-ACTION') },
        h(Icon, { name: 'plus' }),
        '新建任务',
      ),
    ),
    toast === ''
      ? null
      : h('div', { className: 'small', style: { padding: '6px 18px', color: 'var(--m-ok)' } }, toast),
    error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),
    h(
      'div',
      { className: 'tasks-board-wrap' },
      h(
        'div',
        { className: 'tasks-toolbar' },
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
        h('span', { className: 'spacer' }),
        h(
          'select',
          {
            value: projectFilter,
            onChange: (event: { target: { value: string } }) => setProjectFilter(event.target.value),
            'aria-label': '按项目筛选',
          },
          h('option', { value: '' }, '全部项目'),
          projects.map((project) => h('option', { key: project.id, value: project.id }, project.name)),
        ),
        h('span', { className: 'small muted' }, '拖动卡片可改变状态'),
      ),
      h(
        'div',
        { className: 'tasks-board' },
        COLUMNS.map((column) => {
          const cards = tasks
            .filter((task) => task.status === column.status)
            .filter(matchesFilter)
            .filter((task) => projectFilter === '' || task.projectId === projectFilter)
            .sort((left, right) => {
              const leftDue = left.due === '' ? '9999' : left.due.slice(0, 10)
              const rightDue = right.due === '' ? '9999' : right.due.slice(0, 10)
              return leftDue.localeCompare(rightDue)
            })
          return h(
            'div',
            {
              key: column.status,
              className: `task-column task-column-${column.status}`,
              onDragOver: (event: { preventDefault: () => void }) => {
                event.preventDefault()
              },
              onDrop: (event: { preventDefault: () => void }) => {
                event.preventDefault()
                const task = tasks.find((item) => item.id === dragging)
                if (task !== undefined) void move(task, column.status)
                setDragging(null)
              },
            },
            h(
              'div',
              { className: 'task-column-head' },
              h('span', { className: `task-dot ${column.status}` }),
              h('strong', null, column.label),
              h('span', { className: 'task-column-count' }, String(cards.length)),
              h('span', { className: 'spacer' }),
              h(
                'button',
                {
                  className: 'subtle icon',
                  title: `在「${column.label}」中新建`,
                  onClick: () => setCreating(column.status),
                },
                h(Icon, { name: 'plus', size: 14 }),
              ),
            ),
            h(
              'div',
              { className: 'task-column-body' },
              cards.length === 0
                ? h('div', { className: 'task-column-empty' }, column.hint)
                : cards.map((task) =>
                    h(
                      'article',
                      {
                        key: task.id,
                        className: `task-card${dragging === task.id ? ' dragging' : ''}`,
                        draggable: true,
                        onDragStart: () => setDragging(task.id),
                        onDragEnd: () => setDragging(null),
                        onClick: () => setEditing(task),
                      },
                      h(
                        'div',
                        { className: 'task-card-top' },
                        h('span', { className: `task-priority p${String(task.priority)}` }),
                        h('span', { className: 'task-card-title' }, task.title),
                        h(
                          'button',
                          {
                            className: 'task-card-delete',
                            title: '删除任务',
                            onClick: (event: { stopPropagation: () => void }) => {
                              event.stopPropagation()
                              void remove(task)
                            },
                          },
                          h(Icon, { name: 'close', size: 12 }),
                        ),
                      ),
                      task.notes === '' ? null : h('p', { className: 'task-card-notes' }, task.notes),
                      h(
                        'div',
                        { className: 'task-card-meta' },
                        task.due === ''
                          ? null
                          : h(
                              'span',
                              {
                                className:
                                  task.due.slice(0, 10) < dateKey(new Date()) && task.status !== 'COMPLETED'
                                    ? 'task-due overdue'
                                    : 'task-due',
                              },
                              h(Icon, { name: 'calendar', size: 12 }),
                              dueText(task.due),
                            ),
                        task.owner === '' ? null : h('span', { className: 'task-owner' }, task.owner),
                        task.projectId === null
                          ? null
                          : h(
                              'span',
                              { className: 'task-project' },
                              projects.find((project) => project.id === task.projectId)?.name ?? '项目',
                            ),
                        task.priority > 0
                          ? h(
                              'span',
                              { className: 'task-priority-label' },
                              `优先级 ${PRIORITY_LABEL[task.priority] ?? String(task.priority)}`,
                            )
                          : null,
                      ),
                      task.messageKey === ''
                        ? null
                        : h(
                            'button',
                            {
                              className: 'task-source',
                              onClick: (event: { stopPropagation: () => void }) => {
                                event.stopPropagation()
                                void openSource(task)
                              },
                            },
                            h(Icon, { name: 'mail', size: 12 }),
                            '来源邮件',
                          ),
                    ),
                  ),
            ),
          )
        }),
      ),
    ),
    creating !== null || editing !== null
      ? h(TaskEditor, {
          task: editing,
          status: creating ?? 'NEEDS-ACTION',
          projects,
          busy,
          onClose: () => {
            setCreating(null)
            setEditing(null)
          },
          onSave: (draft) => void save(draft),
        })
      : null,
  )
}

function TaskEditor({
  task,
  status,
  projects,
  busy,
  onClose,
  onSave,
}: {
  task: Task | null
  status: Task['status']
  projects: Project[]
  busy: boolean
  onClose: () => void
  onSave: (draft: typeof EMPTY & { id?: string }) => void
}): ReactNode {
  const [draft, setDraft] = useState({
    ...EMPTY,
    status,
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
      wide: true,
      footer: h(
        'div',
        { className: 'task-editor-foot' },
        h('span', { className: 'small muted' }, '提示：任务会保存在本地，可在看板中拖动改变状态。'),
        h('span', { className: 'spacer' }),
        h('button', { className: 'ghost', onClick: onClose }, '取消'),
        h(
          'button',
          {
            className: 'primary',
            disabled: busy || draft.title.trim() === '',
            onClick: () => onSave(draft),
          },
          busy ? '保存中…' : '保存任务',
        ),
      ),
    },
    h(
      'div',
      { className: 'task-editor' },
      h(
        'div',
        { className: 'task-editor-main' },
        h(
          'div',
          { className: 'task-editor-title' },
          h('input', {
            value: draft.title,
            autoFocus: true,
            placeholder: '要做什么？',
            onChange: (event: { target: { value: string } }) => set({ title: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'task-editor-section' },
          h('label', null, '备注'),
          h('textarea', {
            rows: 5,
            value: draft.notes,
            placeholder: '背景、下一步、链接…',
            onChange: (event: { target: { value: string } }) => set({ notes: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'task-editor-section' },
          h('label', null, '来源'),
          draft.id === undefined
            ? h('span', { className: 'small muted' }, '从邮件提取的任务会自动关联来源邮件。')
            : h(
                'span',
                { className: 'small muted' },
                task?.messageSubject !== undefined && task.messageSubject !== ''
                  ? `来自邮件：${task.messageSubject}`
                  : '无关联邮件',
              ),
        ),
      ),
      h(
        'aside',
        { className: 'task-editor-side' },
        h(
          'div',
          { className: 'task-editor-field' },
          h('label', null, '状态'),
          h(
            'select',
            {
              value: draft.status,
              onChange: (event: { target: { value: string } }) =>
                set({ status: event.target.value as Task['status'] }),
            },
            COLUMNS.map((column) => h('option', { key: column.status, value: column.status }, column.label)),
          ),
        ),
        h(
          'div',
          { className: 'task-editor-field' },
          h('label', null, '截止日期'),
          h('input', {
            type: 'date',
            value: draft.due,
            onChange: (event: { target: { value: string } }) => set({ due: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'task-editor-field' },
          h('label', null, '优先级'),
          h(
            'div',
            { className: 'task-priority-picker' },
            [0, 5, 9].map((value) =>
              h(
                'button',
                {
                  key: value,
                  className: draft.priority === value ? 'active' : '',
                  onClick: () => set({ priority: value }),
                },
                PRIORITY_LABEL[value] ?? String(value),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'task-editor-field' },
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
        h(
          'div',
          { className: 'task-editor-field' },
          h('label', null, '负责人'),
          h('input', {
            value: draft.owner,
            placeholder: '可选',
            onChange: (event: { target: { value: string } }) => set({ owner: event.target.value }),
          }),
        ),
      ),
    ),
  )
}
