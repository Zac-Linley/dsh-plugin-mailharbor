---
'@zaclinley/dsh-mailharbor': minor
---

Mailbox sidebar, Kanban tasks and a faster server mode.

- The mail panel gains a left column with the unified inbox, accounts and the
  selected account's folders; server realtime is now the default view.
- Server mail opens much faster: the folder list is cached, the IMAP session is
  kept warm with a periodic NOOP, pages are cached briefly, and folder counts
  are filled from SELECT instead of issuing one STATUS per folder.
- The task panel is a Kanban board (待处理 / 进行中 / 已完成) with drag & drop,
  richer cards and a redesigned task editor.
- CalDAV support was removed; tasks are local-only.
