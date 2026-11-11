---
'@zaclinley/dsh-mailharbor': patch
---

Faster message opening and minimal thread rows.

- Thread candidate lookup goes through the FTS index instead of scanning the
  emails table (raw EML blobs made that take seconds on large archives), and
  reference reads no longer fetch the raw message when the columns are filled.
- Added indexes on `in_reply_to` and `lower(message_id)`; consolidated the
  parent/child queries to indexed lookups.
- Thread results are cached for 30s on the host and 5 minutes in the panel; the
  current page's group renders immediately as a placeholder.
- Collapsed thread rows no longer show a snippet: one line with sender, unread
  dot, attachment icon, recipient count and time.
