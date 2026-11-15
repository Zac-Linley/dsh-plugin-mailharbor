---
'@zaclinley/dsh-mailharbor': minor
---

Searchable project drawer in the task panel.

- The task panel header gains a 项目 button that opens a right-side drawer
  (no main-sidebar entry).
- Drawer supports text search, status tabs, pinned projects, recent ordering,
  per-project task counts, a filter action and opening the project detail.
- Projects store `pinned`, `lastOpenedAt` and `tags`; opening a project touches
  its recent timestamp.
