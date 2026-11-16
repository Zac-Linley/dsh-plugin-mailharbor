---
'@zaclinley/dsh-mailharbor': patch
---

Fix the empty project drawer and refresh its UI.

- Opening the drawer now refetches projects and shows a loading state instead
  of an empty list; a real empty state offers 新建项目 or 清除筛选.
- Status tabs show counts; tags are guarded when absent.
- Drawer header/rows were cleaned up (status dot, meta line, icon buttons) and
  the 新建项目 button is now inside the drawer.
