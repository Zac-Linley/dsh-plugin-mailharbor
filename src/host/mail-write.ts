import { DatabaseSync } from 'node:sqlite'

/** Move one archived message between local mailboxes (the backup is writable). */
export function moveLocalMessage(file: string, id: number, mailbox: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('UPDATE emails SET mailbox = ? WHERE id = ?').run(mailbox, id)
  } finally {
    db.close()
  }
}
