import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DshSessions, DshWorkspaceRegistry } from './dsh.js'
import type { ProjectActivity, ProjectMilestone, ProjectNote, ProjectStatus } from '../shared/types.js'

export interface ProjectMessage {
  accountId: string
  key: string
  subject: string
  date: string
}

export interface ProjectThread {
  accountId: string
  key: string
}

export interface ProjectRecord {
  id: string
  name: string
  status: ProjectStatus
  notes: ProjectNote[]
  milestones: ProjectMilestone[]
  activity: ProjectActivity[]
  path: string
  workspaceId: string
  sessionId: string
  sessionIds: string[]
  accountIds: string[]
  messages: ProjectMessage[]
  threads: ProjectThread[]
  createdAt: string
  updatedAt: string
}

interface ProjectFile {
  version: 2
  projects: ProjectRecord[]
}

/** JSON store for mail-linked projects (few records, no need for SQLite). */
export class ProjectStore {
  private readonly file: string
  private cache: ProjectFile | null = null

  constructor(file: string) {
    this.file = file
  }

  private load(): ProjectFile {
    if (this.cache !== null) return this.cache
    let parsed: unknown = null
    try {
      if (existsSync(this.file)) parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    const projects =
      parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as ProjectFile).projects)
        ? (parsed as ProjectFile).projects
        : []
    this.cache = {
      version: 2,
      projects: projects.filter(isProject).map((project) => ({
        ...project,
        status: project.status ?? 'active',
        notes: Array.isArray(project.notes) ? project.notes : [],
        milestones: Array.isArray(project.milestones) ? project.milestones : [],
        activity: Array.isArray(project.activity) ? project.activity : [],
        sessionIds: Array.isArray(project.sessionIds)
          ? project.sessionIds
          : project.sessionId === ''
            ? []
            : [project.sessionId],
      })),
    }
    return this.cache
  }

  private flush(): void {
    const data = this.load()
    mkdirSync(join(this.file, '..'), { recursive: true })
    const temp = `${this.file}.${String(process.pid)}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  list(): ProjectRecord[] {
    return [...this.load().projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  get(id: string): ProjectRecord | undefined {
    return this.load().projects.find((project) => project.id === id)
  }

  findByMessage(accountId: string, key: string): ProjectRecord | undefined {
    return this.load().projects.find((project) =>
      project.messages.some((message) => message.accountId === accountId && message.key === key),
    )
  }

  create(record: ProjectRecord): ProjectRecord {
    const data = this.load()
    data.projects.push(record)
    this.flush()
    return record
  }

  update(id: string, patch: Partial<ProjectRecord>): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    Object.assign(project, patch, { updatedAt: new Date().toISOString() })
    this.flush()
    return project
  }

  addMessage(id: string, message: ProjectMessage): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    const exists = project.messages.some(
      (item) => item.accountId === message.accountId && item.key === message.key,
    )
    if (!exists) project.messages.push(message)
    if (!project.accountIds.includes(message.accountId)) project.accountIds.push(message.accountId)
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  removeMessage(id: string, accountId: string, key: string): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    project.messages = project.messages.filter((item) => !(item.accountId === accountId && item.key === key))
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  addNote(id: string, body: string, createdAt: string): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    const note: ProjectNote = {
      id: `note_${randomUUID().slice(0, 8)}`,
      body,
      createdAt,
      taskIds: [],
    }
    project.notes.unshift(note)
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  updateNote(id: string, noteId: string, body: string, createdAt: string): ProjectRecord | undefined {
    const project = this.get(id)
    const note = project?.notes.find((item) => item.id === noteId)
    if (project === undefined || note === undefined) return undefined
    note.body = body
    note.createdAt = createdAt
    note.updatedAt = new Date().toISOString()
    project.updatedAt = note.updatedAt
    this.flush()
    return project
  }

  removeNote(id: string, noteId: string): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    project.notes = project.notes.filter((item) => item.id !== noteId)
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  linkNoteTasks(id: string, noteId: string, taskIds: string[]): ProjectRecord | undefined {
    const project = this.get(id)
    const note = project?.notes.find((item) => item.id === noteId)
    if (project === undefined || note === undefined) return undefined
    note.taskIds = [...new Set([...note.taskIds, ...taskIds])]
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  addMilestone(id: string, title: string, due: string): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    project.milestones.push({
      id: `ms_${randomUUID().slice(0, 8)}`,
      title,
      due,
      done: false,
    })
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  updateMilestone(
    id: string,
    milestoneId: string,
    patch: { title?: string; due?: string; done?: boolean },
  ): ProjectRecord | undefined {
    const project = this.get(id)
    const milestone = project?.milestones.find((item) => item.id === milestoneId)
    if (project === undefined || milestone === undefined) return undefined
    if (patch.title !== undefined) milestone.title = patch.title
    if (patch.due !== undefined) milestone.due = patch.due
    if (patch.done !== undefined) milestone.done = patch.done
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  removeMilestone(id: string, milestoneId: string): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    project.milestones = project.milestones.filter((item) => item.id !== milestoneId)
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }

  addActivity(id: string, text: string, at = new Date().toISOString()): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    project.activity.unshift({ id: `act_${randomUUID().slice(0, 8)}`, at, text })
    if (project.activity.length > 100) project.activity.length = 100
    project.updatedAt = at
    this.flush()
    return project
  }

  remove(id: string): boolean {
    const data = this.load()
    const index = data.projects.findIndex((project) => project.id === id)
    if (index < 0) return false
    data.projects.splice(index, 1)
    this.flush()
    return true
  }

  addThread(id: string, thread: ProjectThread): ProjectRecord | undefined {
    const project = this.get(id)
    if (project === undefined) return undefined
    if (!project.threads.some((item) => item.accountId === thread.accountId && item.key === thread.key)) {
      project.threads.push(thread)
    }
    project.updatedAt = new Date().toISOString()
    this.flush()
    return project
  }
}

function isProject(value: unknown): value is ProjectRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ProjectRecord).id === 'string' &&
    typeof (value as ProjectRecord).path === 'string'
  )
}

export function slugify(name: string): string {
  const text = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return text === '' ? 'project' : text.slice(0, 60)
}

export interface CreateProjectInput {
  name: string
  root: string
  conversation: string
  accountId: string
  message?: ProjectMessage
  thread?: ProjectThread
}

export interface CreateProjectResult {
  project: ProjectRecord
  warnings: string[]
}

/**
 * Create a project folder with a brief and the transferred AI conversation,
 * register it as a DSH Workspace, and open a session that starts from it.
 */
export async function createProject(options: {
  store: ProjectStore
  input: CreateProjectInput
  registry?: DshWorkspaceRegistry
  sessions?: DshSessions
}): Promise<CreateProjectResult> {
  const { store, input } = options
  const name = input.name.trim()
  if (name === '') throw new Error('项目名称不能为空')
  if (name.length > 120) throw new Error('项目名称过长')
  const root = input.root.trim()
  if (root === '') throw new Error('项目目录不能为空')

  const warnings: string[] = []
  const id = `prj_${randomUUID().slice(0, 8)}`
  const base = slugify(name)
  let path = join(root, base)
  let attempt = 2
  while (existsSync(path)) {
    path = join(root, `${base}-${String(attempt)}`)
    attempt += 1
  }
  mkdirSync(path, { recursive: true })

  const created = new Date().toISOString()
  const brief = renderBrief(name, input)
  writeFileSync(join(path, 'BRIEF.md'), brief, { mode: 0o600 })
  writeFileSync(join(path, 'CONVERSATION.md'), renderConversation(input.conversation, created), {
    mode: 0o600,
  })

  let workspaceId = ''
  if (options.registry !== undefined) {
    try {
      const workspace = await options.registry.create(path, name)
      workspaceId = String(workspace?.id ?? '')
    } catch (error) {
      warnings.push(`工作空间注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    warnings.push('当前 DSH 组合没有 workspaceRegistry，项目目录已创建但没有注册到侧栏')
  }

  const sessionId = ''

  const project: ProjectRecord = {
    id,
    name,
    status: 'active',
    notes: [],
    milestones: [],
    activity: [],
    path,
    workspaceId,
    sessionId,
    sessionIds: sessionId === '' ? [] : [sessionId],
    accountIds: [input.accountId],
    messages: input.message === undefined ? [] : [input.message],
    threads: input.thread === undefined ? [] : [input.thread],
    createdAt: created,
    updatedAt: created,
  }
  writeFileSync(
    join(path, 'project.json'),
    `${JSON.stringify({ ...project, conversation: undefined }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
  store.create(project)
  return { project, warnings }
}

/** Append new AI cards to an existing project's conversation file. */
export function appendConversation(project: ProjectRecord, conversation: string): string {
  const stamp = new Date().toISOString()
  const file = join(project.path, 'CONVERSATION.md')
  const block = `\n\n## 追加记录 · ${stamp}\n\n${conversation.trim()}\n`
  writeFileSync(file, block, { flag: 'a', mode: 0o600 })
  return file
}

function renderBrief(name: string, input: CreateProjectInput): string {
  const lines = [`# ${name}`, '', `- 创建时间：${new Date().toISOString()}`, `- 来源账号：${input.accountId}`]
  if (input.message !== undefined) {
    lines.push(`- 来源邮件：${input.message.subject}（${input.message.date}）`)
  }
  lines.push(
    '',
    '## 背景',
    '',
    '由 MailHarbor 从邮件生成。以下是当时 AI 工作台的记录。',
    '',
    '## AI 工作台记录',
    '',
    input.conversation.trim(),
    '',
  )
  return lines.join('\n')
}

function renderConversation(conversation: string, created: string): string {
  return `# AI 工作台记录\n\n- 转移到项目：${created}\n\n${conversation.trim()}\n`
}
