---
'@zaclinley/dsh-mailharbor': patch
---

- Projects now appear in the DSH Workspaces sidebar: the plugin waits for the
  optional `workspaceRegistry` service and registers the project workspace
  (and its starting session) instead of leaving a folder-only project.
- CalDAV gets a dedicated "任务与 CalDAV" card in MailHarbor settings: account
  picker, address, username, app password, calendar path, save and "sync now",
  plus the last sync state.
