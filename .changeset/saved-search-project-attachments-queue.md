---
'@zaclinley/dsh-mailharbor': minor
---

Saved searches, project attachments, offline actions and progress.

- Filters can be saved (local storage) and re-applied from the filter popover.
- Attachment previews can copy the file into a chosen project's `attachments/`
  folder, with filename de-duplication.
- Server actions that fail (star, read, move) are queued per account and retried
  after a successful sync; five failed attempts drop the stale action.
- The project list shows a task progress bar; the task board shows today and
  overdue counts.
