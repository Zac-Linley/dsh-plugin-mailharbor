import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import type { Project, ProjectStatus, Task } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { ErrorBar, Modal } from './components.js'

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '进行中',
  paused: '暂停',
  done: '已完成',
  archived: '已归档',
}

const TASK_STATUS: { value: Task['status']; label: string }[] = [
  { value: 'TODO', label: '待办' },
  { value: 'IN-PROCESS', label: '进行中' },
  { value: 'WAITING', label: '等待中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
]

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function localInput(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function noteTitle(body: string): string {
  const first =
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '记录'
  return first.replace(/^#+\s*/, '').slice(0, 80)
}

export function ProjectDetail({
  project,
  onClose,
  onChanged,
}: {
  project: Project
  onClose: () => void
  onChanged: (project: Project) => void
}): ReactNode {
  const [current, setCurrent] = useState(project)
  const [tab, setTab] = useState<'notes' | 'tasks' | 'milestones' | 'activity'>('notes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [noteBody, setNoteBody] = useState('')
  const [noteDate, setNoteDate] = useState(() => localInput(new Date().toISOString()))
  const [editing, setEditing] = useState<{ id: string; body: string; date: string } | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmConvert, setConfirmConvert] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskTitle, setTaskTitle] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [waitingEdit, setWaitingEdit] = useState<{ id: string; value: string } | null>(null)
  const [milestoneTitle, setMilestoneTitle] = useState('')
  const [milestoneDue, setMilestoneDue] = useState('')

  const apply = (next: Project): void => {
    setCurrent(next)
    onChanged(next)
  }

  const loadTasks = async (): Promise<void> => {
    const accountId = current.accountIds[0]
    if (accountId === undefined) return
    try {
      const result = await api.tasks(accountId, { projectId: current.id })
      setTasks(result.items)
    } catch {
      // The notes tab still works without tasks.
    }
  }

  useEffect(() => {
    void loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, current.accountIds[0]])

  const addNote = async (): Promise<void> => {
    if (noteBody.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const createdAt = new Date(noteDate).toISOString()
      const result = await api.addProjectNote(current.id, noteBody.trim(), createdAt)
      apply(result.project)
      setNoteBody('')
      setNoteDate(localInput(new Date().toISOString()))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const saveNote = async (): Promise<void> => {
    if (editing === null || editing.body.trim() === '') return
    setBusy(true)
    try {
      const result = await api.updateProjectNote(
        current.id,
        editing.id,
        editing.body.trim(),
        new Date(editing.date).toISOString(),
      )
      apply(result.project)
      setEditing(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const removeNote = async (noteId: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.deleteProjectNote(current.id, noteId)
      apply(result.project)
      setSelected((ids) => ids.filter((id) => id !== noteId))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const convert = async (): Promise<void> => {
    if (selected.length === 0) return
    setBusy(true)
    setError('')
    try {
      const result = await api.convertProjectNotes(current.id, selected)
      apply(result.project)
      setTasks((items) => [...result.tasks, ...items])
      setSelected([])
      setConfirmConvert(false)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const addTask = async (): Promise<void> => {
    const title = taskTitle.trim()
    const accountId = current.accountIds[0]
    if (title === '' || accountId === undefined) return
    setBusy(true)
    try {
      await api.createTask({
        accountId,
        title,
        projectId: current.id,
        ...(parentId === null ? {} : { parentId }),
        status: 'TODO',
      })
      setTaskTitle('')
      setParentId(null)
      await loadTasks()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const updateTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await api.updateTask(id, patch)
      await loadTasks()
      setWaitingEdit(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const addMilestone = async (): Promise<void> => {
    const title = milestoneTitle.trim()
    if (title === '') return
    setBusy(true)
    try {
      const result = await api.addMilestone(current.id, title, milestoneDue)
      apply(result.project)
      setMilestoneTitle('')
      setMilestoneDue('')
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const toggleMilestone = async (id: string, done: boolean): Promise<void> => {
    try {
      const result = await api.updateMilestone(current.id, id, { done })
      apply(result.project)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const removeMilestone = async (id: string): Promise<void> => {
    try {
      const result = await api.deleteMilestone(current.id, id)
      apply(result.project)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const rootTasks = tasks.filter((task) => task.parentId === null)
  const childOf = (id: string): Task[] => tasks.filter((task) => task.parentId === id)
  const selectedNotes = current.notes.filter((note) => selected.includes(note.id))
  const todo = tasks.filter((task) => task.status === 'TODO' || task.status === 'IN-PROCESS').length
  const waiting = tasks.filter((task) => task.status === 'WAITING').length
  const done = tasks.filter((task) => task.status === 'COMPLETED').length

  return h(
    Modal,
    {
      title: current.name,
      wide: true,
      onClose,
      footer: h(
        'div',
        { className: 'project-detail-foot' },
        h(
          'span',
          { className: 'small muted' },
          `待办 ${String(todo)} · 等待 ${String(waiting)} · 已完成 ${String(done)}`,
        ),
        h('span', { className: 'spacer' }),
        h('button', { className: 'primary small', onClick: onClose }, '关闭'),
      ),
    },
    error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),
    h(
      'div',
      { className: 'project-detail-head' },
      h(
        'select',
        {
          value: current.status,
          'aria-label': '项目状态',
          onChange: (event: { target: { value: string } }) => {
            const status = event.target.value as ProjectStatus
            void api
              .updateProject(current.id, { status })
              .then((result) => apply(result.project))
              .catch((caught: unknown) => setError(errorText(caught)))
          },
        },
        (Object.keys(STATUS_LABEL) as ProjectStatus[]).map((status) =>
          h('option', { key: status, value: status }, STATUS_LABEL[status]),
        ),
      ),
      h(
        'div',
        { className: 'project-detail-tabs' },
        h(
          'button',
          { className: tab === 'notes' ? 'chip active' : 'chip', onClick: () => setTab('notes') },
          `记录 ${String(current.notes.length)}`,
        ),
        h(
          'button',
          { className: tab === 'tasks' ? 'chip active' : 'chip', onClick: () => setTab('tasks') },
          `任务 ${String(tasks.length)}`,
        ),
        h(
          'button',
          {
            className: tab === 'milestones' ? 'chip active' : 'chip',
            onClick: () => setTab('milestones'),
          },
          `里程碑 ${String(current.milestones.length)}`,
        ),
        h(
          'button',
          { className: tab === 'activity' ? 'chip active' : 'chip', onClick: () => setTab('activity') },
          '活动',
        ),
      ),
    ),
    tab === 'milestones'
      ? h(
          'div',
          { className: 'project-milestones' },
          h(
            'div',
            { className: 'project-task-add' },
            h('input', {
              value: milestoneTitle,
              placeholder: '里程碑名称，例如：方案确认',
              onChange: (event: { target: { value: string } }) => setMilestoneTitle(event.target.value),
            }),
            h('input', {
              type: 'date',
              value: milestoneDue,
              'aria-label': '里程碑日期',
              onChange: (event: { target: { value: string } }) => setMilestoneDue(event.target.value),
            }),
            h(
              'button',
              {
                className: 'primary small',
                disabled: busy || milestoneTitle.trim() === '',
                onClick: () => void addMilestone(),
              },
              '添加',
            ),
          ),
          current.milestones.length === 0
            ? h('p', { className: 'small muted' }, '还没有里程碑。里程碑是可选的检查点。')
            : current.milestones.map((milestone) =>
                h(
                  'div',
                  { key: milestone.id, className: 'project-milestone' },
                  h('input', {
                    type: 'checkbox',
                    checked: milestone.done,
                    'aria-label': '里程碑完成',
                    onChange: (event: { target: { checked: boolean } }) =>
                      void toggleMilestone(milestone.id, event.target.checked),
                  }),
                  h('span', { className: milestone.done ? 'done' : '' }, milestone.title),
                  milestone.due === '' ? null : h('span', { className: 'small muted' }, milestone.due),
                  h('span', { className: 'spacer' }),
                  h(
                    'button',
                    { className: 'subtle small danger', onClick: () => void removeMilestone(milestone.id) },
                    '删除',
                  ),
                ),
              ),
        )
      : tab === 'activity'
        ? h(
            'div',
            { className: 'project-activity' },
            current.activity.length === 0
              ? h('p', { className: 'small muted' }, '还没有活动记录。')
              : current.activity.map((event) =>
                  h(
                    'div',
                    { key: event.id, className: 'project-activity-row' },
                    h('span', { className: 'small muted' }, new Date(event.at).toLocaleString()),
                    h('span', null, event.text),
                  ),
                ),
          )
        : tab === 'notes'
          ? h(
              'div',
              { className: 'project-notes' },
              h(
                'div',
                { className: 'project-note-compose' },
                h('textarea', {
                  rows: 3,
                  value: noteBody,
                  placeholder: '记一条进展、决定或资料…',
                  onChange: (event: { target: { value: string } }) => setNoteBody(event.target.value),
                }),
                h(
                  'div',
                  { className: 'project-note-compose-foot' },
                  h('input', {
                    type: 'datetime-local',
                    value: noteDate,
                    'aria-label': '记录时间',
                    onChange: (event: { target: { value: string } }) => setNoteDate(event.target.value),
                  }),
                  h('span', { className: 'spacer' }),
                  h(
                    'button',
                    {
                      className: 'primary small',
                      disabled: busy || noteBody.trim() === '',
                      onClick: () => void addNote(),
                    },
                    '添加记录',
                  ),
                ),
              ),
              selected.length === 0
                ? null
                : h(
                    'div',
                    { className: 'project-note-selection' },
                    h('span', { className: 'small' }, `已选 ${String(selected.length)} 条`),
                    h('span', { className: 'spacer' }),
                    h('button', { className: 'ghost small', onClick: () => setSelected([]) }, '取消选择'),
                    h(
                      'button',
                      { className: 'primary small', onClick: () => setConfirmConvert(true) },
                      '转为任务',
                    ),
                  ),
              current.notes.length === 0
                ? h('p', { className: 'small muted' }, '还没有记录。每次进展或资料都可以记一条。')
                : current.notes.map((note) =>
                    h(
                      'div',
                      { key: note.id, className: 'project-note' },
                      h(
                        'div',
                        { className: 'project-note-head' },
                        h('input', {
                          type: 'checkbox',
                          checked: selected.includes(note.id),
                          'aria-label': '选择记录',
                          onChange: (event: { target: { checked: boolean } }) =>
                            setSelected((ids) =>
                              event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id),
                            ),
                        }),
                        h('span', { className: 'small muted' }, new Date(note.createdAt).toLocaleString()),
                        note.taskIds.length > 0 ? h('span', { className: 'badge ok' }, '已转任务') : null,
                        h('span', { className: 'spacer' }),
                        h(
                          'button',
                          {
                            className: 'subtle small',
                            onClick: () =>
                              setEditing({ id: note.id, body: note.body, date: localInput(note.createdAt) }),
                          },
                          '编辑',
                        ),
                        h(
                          'button',
                          { className: 'subtle small danger', onClick: () => void removeNote(note.id) },
                          '删除',
                        ),
                      ),
                      editing?.id === note.id
                        ? h(
                            'div',
                            { className: 'project-note-edit' },
                            h('textarea', {
                              rows: 3,
                              value: editing.body,
                              onChange: (event: { target: { value: string } }) =>
                                setEditing({ ...editing, body: event.target.value }),
                            }),
                            h(
                              'div',
                              { className: 'project-note-compose-foot' },
                              h('input', {
                                type: 'datetime-local',
                                value: editing.date,
                                onChange: (event: { target: { value: string } }) =>
                                  setEditing({ ...editing, date: event.target.value }),
                              }),
                              h('span', { className: 'spacer' }),
                              h(
                                'button',
                                { className: 'ghost small', onClick: () => setEditing(null) },
                                '取消',
                              ),
                              h(
                                'button',
                                { className: 'primary small', onClick: () => void saveNote() },
                                '保存',
                              ),
                            ),
                          )
                        : h('div', { className: 'project-note-body' }, note.body),
                    ),
                  ),
            )
          : h(
              'div',
              { className: 'project-tasks' },
              h(
                'div',
                { className: 'project-task-add' },
                parentId === null
                  ? null
                  : h('span', { className: 'badge' }, `子任务 of ${parentId.slice(0, 8)}`),
                h('input', {
                  value: taskTitle,
                  placeholder: parentId === null ? '添加任务…' : '添加子任务…',
                  onChange: (event: { target: { value: string } }) => setTaskTitle(event.target.value),
                  onKeyDown: (event: { key: string }) => {
                    if (event.key === 'Enter') void addTask()
                  },
                }),
                h(
                  'button',
                  {
                    className: 'primary small',
                    disabled: busy || taskTitle.trim() === '',
                    onClick: () => void addTask(),
                  },
                  '添加',
                ),
              ),
              rootTasks.length === 0
                ? h('p', { className: 'small muted' }, '这个项目还没有任务。')
                : rootTasks.map((task) =>
                    h(
                      'div',
                      { key: task.id, className: 'project-task-group' },
                      h(
                        'div',
                        { className: 'project-task-row' },
                        h(
                          'select',
                          {
                            value: task.status,
                            'aria-label': '任务状态',
                            onChange: (event: { target: { value: string } }) => {
                              const status = event.target.value as Task['status']
                              if (status === 'WAITING') {
                                setWaitingEdit({ id: task.id, value: task.waitingOn })
                              } else {
                                void updateTask(task.id, { status })
                              }
                            },
                          },
                          TASK_STATUS.map((item) =>
                            h('option', { key: item.value, value: item.value }, item.label),
                          ),
                        ),
                        h('span', { className: 'project-task-title' }, task.title),
                        task.status === 'WAITING' && task.waitingOn !== ''
                          ? h('span', { className: 'small muted' }, `等待：${task.waitingOn}`)
                          : null,
                        h('span', { className: 'spacer' }),
                        h(
                          'button',
                          { className: 'subtle small', onClick: () => setParentId(task.id) },
                          '＋子任务',
                        ),
                      ),
                      waitingEdit?.id === task.id
                        ? h(
                            'div',
                            { className: 'project-task-waiting' },
                            h('input', {
                              value: waitingEdit.value,
                              placeholder: '等谁 / 等什么',
                              onChange: (event: { target: { value: string } }) =>
                                setWaitingEdit({ id: task.id, value: event.target.value }),
                            }),
                            h(
                              'button',
                              {
                                className: 'primary small',
                                disabled: waitingEdit.value.trim() === '',
                                onClick: () =>
                                  void updateTask(task.id, {
                                    status: 'WAITING',
                                    waitingOn: waitingEdit.value.trim(),
                                  }),
                              },
                              '保存',
                            ),
                            h(
                              'button',
                              { className: 'ghost small', onClick: () => setWaitingEdit(null) },
                              '取消',
                            ),
                          )
                        : null,
                      childOf(task.id).map((child) =>
                        h(
                          'div',
                          { key: child.id, className: 'project-task-row child' },
                          h(
                            'select',
                            {
                              value: child.status,
                              'aria-label': '子任务状态',
                              onChange: (event: { target: { value: string } }) =>
                                void updateTask(child.id, { status: event.target.value }),
                            },
                            TASK_STATUS.map((item) =>
                              h('option', { key: item.value, value: item.value }, item.label),
                            ),
                          ),
                          h('span', { className: 'project-task-title' }, child.title),
                          child.waitingOn === ''
                            ? null
                            : h('span', { className: 'small muted' }, `等待：${child.waitingOn}`),
                        ),
                      ),
                    ),
                  ),
            ),
    confirmConvert
      ? h(
          Modal,
          {
            title: '记录转为任务',
            onClose: () => setConfirmConvert(false),
            footer: h(
              'div',
              { className: 'project-detail-foot' },
              h('span', { className: 'small muted' }, `将创建 ${String(selectedNotes.length)} 个任务`),
              h('span', { className: 'spacer' }),
              h('button', { className: 'ghost', onClick: () => setConfirmConvert(false) }, '取消'),
              h(
                'button',
                { className: 'primary', disabled: busy, onClick: () => void convert() },
                '确认创建',
              ),
            ),
          },
          h(
            'ul',
            { className: 'project-convert-list' },
            selectedNotes.map((note) => h('li', { key: note.id }, noteTitle(note.body))),
          ),
        )
      : null,
  )
}
