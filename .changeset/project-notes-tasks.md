---
'@zaclinley/dsh-mailharbor': minor
---

Project notes timeline and the new task model.

- Projects gain a dated notes timeline (add / edit / delete); selected records
  convert into tasks one-by-one, and the note keeps a link to the task.
- Manual project statuses: 进行中 / 暂停 / 已完成 / 已归档. No progress
  percentage, health or success-criteria fields.
- Project cards show 待办 · 等待 · 完成 counts instead of a progress bar.
- Tasks now use 待办 / 进行中 / 等待中 / 已完成 / 已取消; waiting requires a
  "等谁/等什么" reason, and two-level subtasks are supported.
- Project detail modal: notes, inline task list, subtask creation and status
  changes.
- Creating a project no longer auto-creates a DSH session; sessions will be
  created on demand later.
