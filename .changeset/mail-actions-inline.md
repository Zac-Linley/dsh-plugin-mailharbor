---
'@zaclinley/dsh-mailharbor': minor
---

Inline signature images and everyday mail actions.

- Inline `cid:` images (signatures, embedded screenshots) are rewritten to
  data URLs in the reader for both server and archived mail, instead of
  appearing as attachments or broken images.
- Star, archive, delete-to-trash and move-to-folder actions in the reader; the
  local backup is updated and the server is moved when the message still exists
  there.
- Selection mode gains bulk read/unread/star/archive/delete.
- Stars are stored locally and mirrored to IMAP `\Flagged`; the list shows a
  star marker.
