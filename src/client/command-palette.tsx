import { createElement as h, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project, Task } from '../shared/types.js'
import { Modal } from './components.js'

export function CommandPalette({
  projects,
  tasks,
  onProject,
  onTask,
  onNewTask,
  onNewProject,
  onClose,
}: {
  projects: Project[]
  tasks: Task[]
  onProject: (project: Project) => void
  onTask: (task: Task) => void
  onNewTask: () => void
  onNewProject: () => void
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const projectHits = useMemo(
    () =>
      projects
        .filter((project) => {
          if (needle === '') return project.status !== 'archived'
          return `${project.name} ${project.tags.join(' ')}`.toLowerCase().includes(needle)
        })
        .slice(0, 6),
    [projects, needle],
  )
  const taskHits = useMemo(
    () =>
      tasks
        .filter((task) => {
          if (needle === '') return task.status !== 'COMPLETED' && task.status !== 'CANCELLED'
          return task.title.toLowerCase().includes(needle)
        })
        .slice(0, 8),
    [tasks, needle],
  )
  const first = projectHits[0] ?? taskHits[0]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && first !== undefined) {
        event.preventDefault()
        if ('name' in first) onProject(first)
        else onTask(first)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [first, onProject, onTask])

  return h(
    Modal,
    { title: '搜索项目与任务', onClose },
    h('input', {
      type: 'search',
      autoFocus: true,
      value: query,
      placeholder: '输入项目名、标签或任务标题…',
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
    h(
      'div',
      { className: 'command-palette' },
      projectHits.length === 0 ? null : h('div', { className: 'command-section' }, '项目'),
      projectHits.map((project) =>
        h(
          'button',
          {
            key: project.id,
            className: 'command-row',
            onClick: () => onProject(project),
          },
          h('strong', null, project.name),
          h(
            'span',
            { className: 'small muted' },
            `${project.status === 'active' ? '进行中' : project.status === 'paused' ? '暂停' : project.status === 'done' ? '已完成' : '已归档'}${project.tags.length === 0 ? '' : ` · ${project.tags.join(' · ')}`}`,
          ),
        ),
      ),
      taskHits.length === 0 ? null : h('div', { className: 'command-section' }, '任务'),
      taskHits.map((task) =>
        h(
          'button',
          {
            key: task.id,
            className: 'command-row',
            onClick: () => onTask(task),
          },
          h('strong', null, task.title),
          h(
            'span',
            { className: 'small muted' },
            `${task.status === 'TODO' ? '待办' : task.status === 'IN-PROCESS' ? '进行中' : task.status === 'WAITING' ? `等待：${task.waitingOn}` : task.status === 'COMPLETED' ? '已完成' : '已取消'}${task.due === '' ? '' : ` · ${task.due.slice(0, 10)}`}`,
          ),
        ),
      ),
      needle === '' && projectHits.length === 0 && taskHits.length === 0
        ? h('p', { className: 'small muted' }, '还没有项目或任务。')
        : null,
      h('div', { className: 'command-section' }, '新建'),
      h('button', { className: 'command-row', onClick: onNewTask }, '＋ 新建任务'),
      h('button', { className: 'command-row', onClick: onNewProject }, '＋ 新建项目'),
    ),
  )
}
