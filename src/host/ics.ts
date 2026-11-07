/** Minimal iCalendar (RFC 5545) support for VTODO tasks, no dependencies. */
import type { TaskRecord } from './tasks.js'

const CRLF = '\r\n'

export function escapeText(value: string): string {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n')
}

export function unescapeText(value: string): string {
  return String(value ?? '')
    .replaceAll('\\n', '\n')
    .replaceAll('\\N', '\n')
    .replaceAll('\\,', ',')
    .replaceAll('\\;', ';')
    .replaceAll('\\\\', '\\')
}

function fold(line: string): string {
  const text = String(line)
  if (text.length <= 74) return text
  const chunks: string[] = []
  let rest = text
  while (rest.length > 74) {
    chunks.push(rest.slice(0, 74))
    rest = ` ${rest.slice(74)}`
  }
  chunks.push(rest)
  return chunks.join(CRLF)
}

function utcStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dueProperty(due: string): string | null {
  const text = String(due ?? '').trim()
  if (text === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `DUE;VALUE=DATE:${text.replaceAll('-', '')}`
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return `DUE:${utcStamp(parsed)}`
}

export function serializeTodos(tasks: Partial<TaskRecord>[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dsh-mailharbor//VTODO//EN',
    'CALSCALE:GREGORIAN',
  ]
  for (const task of tasks) {
    lines.push('BEGIN:VTODO')
    lines.push(`UID:${String(task.uid ?? task.id ?? '')}`)
    lines.push(`DTSTAMP:${utcStamp(new Date())}`)
    lines.push(`SUMMARY:${escapeText(task.title ?? '(无标题)')}`)
    if (task.notes !== undefined && task.notes !== null && String(task.notes) !== '') {
      lines.push(`DESCRIPTION:${escapeText(task.notes)}`)
    }
    const due = dueProperty(String(task.due ?? ''))
    if (due !== null) lines.push(due)
    lines.push(`STATUS:${String(task.status ?? 'NEEDS-ACTION').toUpperCase()}`)
    if (Number(task.priority ?? 0) > 0)
      lines.push(`PRIORITY:${String(Math.max(0, Math.min(9, Number(task.priority))))}`)
    if (String(task.status ?? '').toUpperCase() === 'COMPLETED') {
      const completed =
        task.completedAt === undefined || task.completedAt === null ? new Date() : new Date(task.completedAt)
      if (!Number.isNaN(completed.getTime())) lines.push(`COMPLETED:${utcStamp(completed)}`)
    }
    lines.push('END:VTODO')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(fold).join(CRLF)}${CRLF}`
}

export interface ParsedTodo {
  uid: string
  title: string
  notes: string
  due: string
  status: string
  priority: number
  completedAt: string | null
}

function unfold(text: string): string {
  return String(text ?? '').replace(/\r?\n[ \t]/g, '')
}

function decodeDue(value: string, params: string): string {
  const text = String(value ?? '').trim()
  if (params.includes('VALUE=DATE') || /^\d{8}$/.test(text)) {
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    return ''
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text)
  if (match !== null) {
    const date = new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    )
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return ''
}

/** Parse every VTODO in an iCalendar stream. */
export function parseTodos(ics: string): ParsedTodo[] {
  const lines = unfold(ics).split(/\r?\n/)
  const todos: ParsedTodo[] = []
  let current: Partial<ParsedTodo> | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'BEGIN:VTODO') {
      current = {}
      continue
    }
    if (trimmed === 'END:VTODO') {
      if (current !== null && String(current.uid ?? '') !== '') {
        todos.push({
          uid: String(current.uid),
          title: String(current.title ?? '(无标题)'),
          notes: String(current.notes ?? ''),
          due: String(current.due ?? ''),
          status: String(current.status ?? 'NEEDS-ACTION'),
          priority: Number(current.priority ?? 0),
          completedAt: current.completedAt ?? null,
        })
      }
      current = null
      continue
    }
    if (current === null) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const left = trimmed.slice(0, colon)
    const value = trimmed.slice(colon + 1)
    const semicolon = left.indexOf(';')
    const name = (semicolon < 0 ? left : left.slice(0, semicolon)).toUpperCase()
    const params = semicolon < 0 ? '' : left.slice(semicolon + 1).toUpperCase()
    if (name === 'UID') current.uid = unescapeText(value).trim()
    else if (name === 'SUMMARY') current.title = unescapeText(value)
    else if (name === 'DESCRIPTION') current.notes = unescapeText(value)
    else if (name === 'STATUS') current.status = value.trim().toUpperCase()
    else if (name === 'PRIORITY') current.priority = Number(value) || 0
    else if (name === 'DUE') current.due = decodeDue(value, params)
    else if (name === 'COMPLETED') {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim())
      if (match !== null) {
        current.completedAt = new Date(
          Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          ),
        ).toISOString()
      }
    }
  }
  return todos
}
