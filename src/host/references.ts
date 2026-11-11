import { DatabaseSync } from 'node:sqlite'
import { ensureMailSchema } from './mail-db.js'

export interface ReferenceHeaders {
  inReplyTo: string | null
  references: string | null
}

/** Read only the header block, so multi-megabyte bodies stay untouched. */
export function extractReferences(raw: Uint8Array | null | undefined, messageId: string): ReferenceHeaders {
  const empty: ReferenceHeaders = { inReplyTo: null, references: null }
  if (raw === null || raw === undefined) return empty
  const text = Buffer.from(raw.subarray(0, Math.min(raw.byteLength, 200_000))).toString('utf8')
  const separator = text.search(/\r?\n\r?\n/)
  const head = separator >= 0 ? text.slice(0, separator) : text
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
  const value = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)
    return match === null ? '' : String(match[1] ?? '')
  }
  const ids = (value: string): string[] =>
    value
      .split(/\s+/)
      .map((item) => item.replace(/^<|>$/g, '').toLowerCase())
      .filter((item) => item.includes('@'))
  const referenceIds = ids(value('references'))
  const replyTo = ids(value('in-reply-to'))
  // A message never references itself.
  const filteredRefs = referenceIds.filter((id) => id !== messageId.toLowerCase())
  return {
    inReplyTo: replyTo[0] ?? null,
    references: filteredRefs.length > 0 ? filteredRefs.join(' ') : null,
  }
}

export interface BackfillResult {
  updated: number
  remaining: number
}

/**
 * Fill `in_reply_to` / `references` for old rows one batch at a time.
 * `refs_indexed` prevents reprocessing headers that genuinely have no refs.
 */
export function backfillReferences(file: string, batchSize = 300): BackfillResult {
  ensureMailSchema(file)
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    const rows = db
      .prepare('SELECT id, message_id, raw_eml FROM emails WHERE refs_indexed = 0 ORDER BY id LIMIT ?')
      .all(batchSize) as { id?: number; message_id?: string; raw_eml?: Uint8Array | null }[]
    if (rows.length === 0) return { updated: 0, remaining: 0 }
    const update = db.prepare(
      'UPDATE emails SET in_reply_to = ?, "references" = ?, refs_indexed = 1 WHERE id = ?',
    )
    db.exec('BEGIN')
    try {
      for (const row of rows) {
        const headers = extractReferences(row.raw_eml, String(row.message_id ?? ''))
        update.run(headers.inReplyTo, headers.references, Number(row.id))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const remaining = Number(
      db.prepare('SELECT COUNT(*) AS count FROM emails WHERE refs_indexed = 0').get()?.count ?? 0,
    )
    return { updated: rows.length, remaining }
  } finally {
    db.close()
  }
}
