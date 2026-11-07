---
'@zaclinley/dsh-mailharbor': minor
---

Mail search, conversation grouping and a four-column task board.

- Sent folders show the recipients instead of the sender.
- The mail list groups messages by conversation title; a count chip expands the thread.
- The search box is an AI search: a sentence is parsed into sender/keywords/dates and
  searched across local folders, with a timeout fallback to plain search.
- The account header toggles the account/folder sidebar; the unified inbox is gone and
  the top-bar add-account button no longer occupies space.
- Project directories can be picked in Finder / the file manager.
- The task board is four columns (待处理 / 进行中 / 已完成 / 终止), without the progress
  summary, with project filtering and drag & drop.
- CalDAV remains removed; tasks stay local.
