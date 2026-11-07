import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CalDavClient, CalDavSyncResult } from './caldav.js'

const STATUSES = new Set(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'])

function now(): string {
  return new Date().toISOString()
}

export interface TaskRecord {
  id: string
  accountId: string
  projectId: string | null
  calendarHref: string | null
  href: string | null
  etag: string | null
  uid: string
  title: string
  notes: string
  due: string
  status: string
  priority: number
  owner: string
  messageKey: string
  messageSubject: string
  completedAt: string | null
  dirty: boolean
  deleted: boolean
  createdAt: string
  updatedAt: string
}

function rowToTask(row: Record<string, unknown> | undefined): TaskRecord | undefined {
  if (row === undefined) return undefined
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    calendarHref:
      row.calendar_href === null || row.calendar_href === undefined ? null : String(row.calendar_href),
    href: row.href === null || row.href === undefined ? null : String(row.href),
    etag: row.etag === null || row.etag === undefined ? null : String(row.etag),
    uid: String(row.uid),
    title: String(row.title),
    notes: String(row.notes ?? ''),
    due: String(row.due ?? ''),
    status: String(row.status ?? 'NEEDS-ACTION'),
    priority: Number(row.priority ?? 0),
    owner: String(row.owner ?? ''),
    messageKey: String(row.message_key ?? ''),
    messageSubject: String(row.message_subject ?? ''),
    completedAt:
      row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    dirty: Number(row.dirty) === 1,
    deleted: Number(row.deleted) === 1,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }
}

function statusOf(value: unknown): string {
  const text = String(value ?? 'NEEDS-ACTION').toUpperCase()
  return STATUSES.has(text) ? text : 'NEEDS-ACTION'
}

/**
 * Local VTODO store in `<DataRoot>/state/state.db`.
 *
 * Local edits set dirty=1; CalDAV sync pushes dirty rows and applies remote
 * rows when there is no pending local edit. Deletions leave a tombstone until
 * the remote DELETE succeeds.
 */
export class TaskStore {
  private readonly file: string
  private db: DatabaseSync | null = null

  constructor(file: string) {
    this.file = file
  }

  close(): void {
    if (this.db !== null) {
      this.db.close()
      this.db = null
    }
  }

  private open(): DatabaseSync {
    if (this.db !== null) return this.db
    mkdirSync(dirname(this.file), { recursive: true })
    const db = new DatabaseSync(this.file)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=10000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        project_id TEXT,
        calendar_href TEXT,
        href TEXT,
        etag TEXT,
        uid TEXT NOT NULL,
        title TEXT NOT NULL,
        notes TEXT,
        due TEXT,
        status TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
        priority INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        message_key TEXT,
        message_subject TEXT,
        completed_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_account_due ON tasks (account_id, deleted, status, due);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id);
      CREATE TABLE IF NOT EXISTS calendar_state (
        account_id TEXT PRIMARY KEY,
        calendar_href TEXT,
        display_name TEXT,
        ctag TEXT,
        last_sync TEXT,
        error TEXT
      );
    `)
    this.db = db
    return db
  }

  list(options: {
    accountId: string
    status?: string
    projectId?: string
    query?: string
    limit?: number
  }): TaskRecord[] {
    const db = this.open()
    const where = ['account_id = ?', 'deleted = 0']
    const params: (string | number)[] = [options.accountId]
    if (options.status !== undefined && options.status !== '') {
      where.push('status = ?')
      params.push(statusOf(options.status))
    }
    if (options.projectId !== undefined && options.projectId !== '') {
      where.push('project_id = ?')
      params.push(options.projectId)
    }
    const text = String(options.query ?? '').trim()
    if (text !== '') {
      where.push('(title LIKE ? OR notes LIKE ? OR owner LIKE ?)')
      const like = `%${text}%`
      params.push(like, like, like)
    }
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE ${where.join(' AND ')}
         ORDER BY CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END,
                  CASE WHEN due IS NULL OR due = '' THEN 1 ELSE 0 END, due ASC, created_at DESC
         LIMIT ?`,
      )
      .all(...params, Math.max(1, Math.min(1000, options.limit ?? 500)))
    return rows
      .map((row) => rowToTask(row as Record<string, unknown>))
      .filter((task): task is TaskRecord => task !== undefined)
  }

  get(id: string): TaskRecord | undefined {
    return rowToTask(
      this.open().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined,
    )
  }

  create(input: {
    accountId: string
    title: string
    notes?: string
    due?: string
    status?: string
    priority?: number
    owner?: string
    projectId?: string | null
    messageKey?: string
    messageSubject?: string
  }): TaskRecord {
    const title = String(input.title ?? '').trim()
    if (title === '') throw new Error('任务标题不能为空')
    if (title.length > 300) throw new Error('任务标题过长')
    const status = statusOf(input.status)
    const id = `task_${randomUUID()}`
    const stamp = now()
    this.open()
      .prepare(
        `INSERT INTO tasks (id, account_id, project_id, uid, title, notes, due, status, priority, owner,
                            message_key, message_subject, completed_at, dirty, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(
        id,
        input.accountId,
        input.projectId ?? null,
        `${randomUUID()}@dsh-mailharbor`,
        title,
        String(input.notes ?? ''),
        String(input.due ?? ''),
        status,
        Math.max(0, Math.min(9, Number(input.priority ?? 0))),
        String(input.owner ?? ''),
        String(input.messageKey ?? ''),
        String(input.messageSubject ?? ''),
        status === 'COMPLETED' ? stamp : null,
        stamp,
        stamp,
      )
    const task = this.get(id)
    if (task === undefined) throw new Error('任务创建失败')
    return task
  }

  update(id: string, fields: Partial<TaskRecord> & { projectId?: string | null }): TaskRecord {
    const current = this.get(id)
    if (current === undefined) throw new Error('任务不存在')
    const next = {
      title: fields.title === undefined ? current.title : String(fields.title).trim(),
      notes: fields.notes === undefined ? current.notes : String(fields.notes ?? ''),
      due: fields.due === undefined ? current.due : String(fields.due ?? ''),
      status: fields.status === undefined ? current.status : statusOf(fields.status),
      priority: fields.priority === undefined ? current.priority : Number(fields.priority),
      owner: fields.owner === undefined ? current.owner : String(fields.owner ?? ''),
      projectId: fields.projectId === undefined ? current.projectId : fields.projectId,
      messageKey: fields.messageKey === undefined ? current.messageKey : String(fields.messageKey),
      messageSubject:
        fields.messageSubject === undefined ? current.messageSubject : String(fields.messageSubject),
    }
    if (next.title === '') throw new Error('任务标题不能为空')
    const stamp = now()
    const completedAt = next.status === 'COMPLETED' ? (current.completedAt ?? stamp) : null
    this.open()
      .prepare(
        `UPDATE tasks SET title = ?, notes = ?, due = ?, status = ?, priority = ?, owner = ?, project_id = ?,
                message_key = ?, message_subject = ?, completed_at = ?, dirty = 1, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.notes,
        next.due,
        next.status,
        Math.max(0, Math.min(9, Number(next.priority) || 0)),
        next.owner,
        next.projectId,
        next.messageKey,
        next.messageSubject,
        completedAt,
        stamp,
        id,
      )
    const task = this.get(id)
    if (task === undefined) throw new Error('任务更新失败')
    return task
  }

  remove(id: string): boolean {
    const current = this.get(id)
    if (current === undefined) return false
    if (current.href !== null && current.href !== '') {
      this.open()
        .prepare('UPDATE tasks SET deleted = 1, dirty = 1, updated_at = ? WHERE id = ?')
        .run(now(), id)
    } else {
      this.open().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    }
    return true
  }

  /** Apply a VTODO fetched from CalDAV; local pending edits win over remote. */
  applyRemote(input: {
    accountId: string
    calendarHref: string
    href: string
    etag: string | null
    todo: {
      uid: string
      title: string
      notes: string
      due: string
      status: string
      priority: number
      completedAt: string | null
    }
  }): TaskRecord | undefined {
    const db = this.open()
    const existing =
      (db
        .prepare('SELECT * FROM tasks WHERE account_id = ? AND href = ?')
        .get(input.accountId, input.href) as Record<string, unknown> | undefined) ??
      (db
        .prepare('SELECT * FROM tasks WHERE account_id = ? AND uid = ?')
        .get(input.accountId, input.todo.uid) as Record<string, unknown> | undefined)
    const status = statusOf(input.todo.status)
    const completedAt = status === 'COMPLETED' ? (input.todo.completedAt ?? now()) : null
    if (existing !== undefined) {
      if (Number(existing.dirty) === 1) return rowToTask(existing)
      db.prepare(
        `UPDATE tasks SET calendar_href = ?, href = ?, etag = ?, title = ?, notes = ?, due = ?, status = ?, priority = ?,
                completed_at = ?, dirty = 0, deleted = 0, updated_at = ? WHERE id = ?`,
      ).run(
        input.calendarHref,
        input.href,
        input.etag,
        String(input.todo.title || existing.title),
        String(input.todo.notes ?? ''),
        String(input.todo.due ?? ''),
        status,
        Math.max(0, Math.min(9, Number(input.todo.priority) || 0)),
        completedAt,
        now(),
        String(existing.id),
      )
      return this.get(String(existing.id))
    }
    const id = `task_${randomUUID()}`
    const stamp = now()
    db.prepare(
      `INSERT INTO tasks (id, account_id, calendar_href, href, etag, uid, title, notes, due, status, priority,
                          completed_at, dirty, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(
      id,
      input.accountId,
      input.calendarHref,
      input.href,
      input.etag,
      input.todo.uid || `${randomUUID()}@dsh-mailharbor`,
      String(input.todo.title || '(无标题)'),
      String(input.todo.notes ?? ''),
      String(input.todo.due ?? ''),
      status,
      Math.max(0, Math.min(9, Number(input.todo.priority) || 0)),
      completedAt,
      stamp,
      stamp,
    )
    return this.get(id)
  }

  pending(accountId: string): TaskRecord[] {
    return this.open()
      .prepare('SELECT * FROM tasks WHERE account_id = ? AND dirty = 1')
      .all(accountId)
      .map((row) => rowToTask(row as Record<string, unknown>))
      .filter((task): task is TaskRecord => task !== undefined)
  }

  markPushed(id: string, result: { href: string; etag: string | null; uid: string }): TaskRecord | undefined {
    this.open()
      .prepare(
        'UPDATE tasks SET href = ?, etag = ?, uid = ?, dirty = 0, deleted = 0, updated_at = ? WHERE id = ?',
      )
      .run(result.href, result.etag, result.uid, now(), id)
    return this.get(id)
  }

  purge(id: string): void {
    this.open().prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  /** Remove local copies whose remote VTODO disappeared (not dirty, not tombstoned). */
  pruneMissingRemote(accountId: string, calendarHref: string, hrefs: string[]): number {
    const db = this.open()
    const present = new Set(hrefs)
    const rows = db
      .prepare(
        `SELECT id, href FROM tasks
         WHERE account_id = ? AND dirty = 0 AND deleted = 0 AND href IS NOT NULL
           AND (calendar_href = ? OR calendar_href IS NULL OR calendar_href = '')`,
      )
      .all(accountId, calendarHref)
    let removed = 0
    for (const row of rows) {
      if (present.has(String(row.href))) continue
      db.prepare('DELETE FROM tasks WHERE id = ?').run(String(row.id))
      removed += 1
    }
    return removed
  }

  calendarState(accountId: string): { calendarHref: string; lastSync: string; error: string } | null {
    const row = this.open().prepare('SELECT * FROM calendar_state WHERE account_id = ?').get(accountId) as
      Record<string, unknown> | undefined
    if (row === undefined) return null
    return {
      calendarHref: String(row.calendar_href ?? ''),
      lastSync: String(row.last_sync ?? ''),
      error: String(row.error ?? ''),
    }
  }

  setCalendarState(
    accountId: string,
    state: { calendarHref?: string | null; lastSync?: string | null; error?: string | null },
  ): void {
    this.open()
      .prepare(
        `INSERT INTO calendar_state (account_id, calendar_href, display_name, ctag, last_sync, error)
         VALUES (?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET calendar_href = excluded.calendar_href,
           last_sync = excluded.last_sync, error = excluded.error`,
      )
      .run(accountId, state.calendarHref ?? null, state.lastSync ?? null, state.error ?? null)
  }

  /** Pull remote tasks, push local edits, and record the sync result. */
  async sync(accountId: string, client: CalDavClient): Promise<CalDavSyncResult> {
    try {
      const result = await client.sync(this, accountId)
      this.setCalendarState(accountId, {
        calendarHref: result.calendarHref,
        lastSync: new Date().toISOString(),
        error: null,
      })
      return result
    } catch (error) {
      this.setCalendarState(accountId, {
        lastSync: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export type { CalDavSyncResult }
