import { describe, expect, it } from 'vitest'
import { parseTodos, serializeTodos } from '../src/host/ics.js'

describe('VTODO serialization', () => {
  it('round-trips title, notes, due and status', () => {
    const ics = serializeTodos([
      {
        uid: 'task-1@dsh-mailharbor',
        title: '确认报价单',
        notes: '周五前回复，抄送王敏',
        due: '2026-11-13',
        status: 'IN-PROCESS',
        priority: 5,
      },
    ])
    expect(ics).toContain('BEGIN:VTODO')
    expect(ics).toContain('SUMMARY:确认报价单')
    const [todo] = parseTodos(ics)
    expect(todo?.uid).toBe('task-1@dsh-mailharbor')
    expect(todo?.title).toBe('确认报价单')
    expect(todo?.notes).toBe('周五前回复，抄送王敏')
    expect(todo?.due).toBe('2026-11-13')
    expect(todo?.status).toBe('IN-PROCESS')
    expect(todo?.priority).toBe(5)
  })

  it('records completion and escapes commas', () => {
    const ics = serializeTodos([
      { uid: 'u2', title: 'A, B; C', status: 'COMPLETED', completedAt: '2026-11-07T09:00:00.000Z' },
    ])
    expect(ics).toContain('SUMMARY:A\\, B\\; C')
    expect(ics).toContain('COMPLETED:20261107T090000Z')
    const [todo] = parseTodos(ics)
    expect(todo?.title).toBe('A, B; C')
    expect(todo?.status).toBe('COMPLETED')
  })

  it('ignores blocks without a UID and parses several todos', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTODO',
      'SUMMARY:no uid',
      'END:VTODO',
      'BEGIN:VTODO',
      'UID:x',
      'SUMMARY:one',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(parseTodos(ics).map((todo) => todo.title)).toEqual(['one'])
  })
})
