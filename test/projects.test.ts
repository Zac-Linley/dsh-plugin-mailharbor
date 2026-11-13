import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore, appendConversation, createProject } from '../src/host/projects.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-projects-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createProject', () => {
  it('creates the folder, brief and conversation without auto-starting a session', async () => {
    const store = new ProjectStore(join(dir, 'projects.json'))
    const result = await createProject({
      store,
      input: {
        name: '星港二期',
        root: join(dir, 'projects'),
        conversation: '### AI 摘要\n\n请确认报价。',
        accountId: 'acc_1',
        message: { accountId: 'acc_1', key: 'mid:m1', subject: '报价确认', date: '2026-11-06' },
      },
      registry: { create: async () => ({ id: 'ws_1' }) },
    })

    expect(result.project.workspaceId).toBe('ws_1')
    expect(result.project.sessionId).toBe('')
    expect(existsSync(join(result.project.path, 'BRIEF.md'))).toBe(true)
    expect(readFileSync(join(result.project.path, 'CONVERSATION.md'), 'utf8')).toContain('请确认报价')
    expect(store.findByMessage('acc_1', 'mid:m1')?.id).toBe(result.project.id)
  })

  it('keeps working when the composition lacks workspace services', async () => {
    const store = new ProjectStore(join(dir, 'projects.json'))
    const result = await createProject({
      store,
      input: { name: '无服务', root: join(dir, 'projects'), conversation: '记录', accountId: 'acc_1' },
    })
    expect(result.project.workspaceId).toBe('')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(existsSync(result.project.path)).toBe(true)
  })

  it('appends later transfers and links messages', () => {
    const store = new ProjectStore(join(dir, 'projects.json'))
    mkdirSync(join(dir, 'p'), { recursive: true })
    const project = store.create({
      id: 'prj_1',
      name: 'p',
      status: 'active',
      notes: [],
      milestones: [],
      activity: [],
      path: join(dir, 'p'),
      workspaceId: '',
      sessionId: '',
      sessionIds: [],
      accountIds: ['acc_1'],
      messages: [],
      threads: [],
      createdAt: '2026-11-07T00:00:00Z',
      updatedAt: '2026-11-07T00:00:00Z',
    })
    appendConversation(project, '新的卡片')
    expect(readFileSync(join(dir, 'p', 'CONVERSATION.md'), 'utf8')).toContain('新的卡片')

    const linked = store.addMessage(project.id, { accountId: 'acc_1', key: 'mid:m2', subject: 's', date: '' })
    expect(linked?.messages).toHaveLength(1)
    expect(store.findByMessage('acc_1', 'mid:m2')?.id).toBe(project.id)
    store.removeMessage(project.id, 'acc_1', 'mid:m2')
    expect(store.findByMessage('acc_1', 'mid:m2')).toBeUndefined()
  })
})
