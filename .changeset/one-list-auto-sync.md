---
'@zaclinley/dsh-mailharbor': minor
---

One mail list: local first, automatic server sync.

- The 本地备份 / 服务器实时 switch is gone. The panel opens the local backup
  immediately, then runs an incremental IMAP sync on open and every
  `read.pollSeconds` in the background.
- The sync button shows a spinner while running and opens a small popover with
  progress, counters, recent log and start/stop, instead of a centred dialog.
- The list refreshes when a sync finishes, so new mail just appears.
- Many attachments collapse to the first three with a "+N 个附件" toggle.
- Thread cards and AI cards no longer shrink when a thread is long.
- AI cards expand the full answer inline inside the assistant rail (no separate
  dialog).
