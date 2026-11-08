---
'@zaclinley/dsh-mailharbor': patch
---

Clear project actions and a project manager.

- The "加入项目" dialog is a two-mode choice: "加入已有项目" (no new project) or
  "新建项目" (creates one); the primary button says which action it performs.
- A "项目" button in the mail toolbar opens a manager with rename, open folder
  and delete. Delete removes the MailHarbor record and unlinks its tasks; the
  project folder and DSH workspace stay on disk, as the dialog states.
