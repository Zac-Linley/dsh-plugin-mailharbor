---
'@zaclinley/dsh-mailharbor': patch
---

Project cleanup, sync errors, signatures, contacts and full threads.

- Deleting a project can now also remove its folder and unregister the DSH
  workspace (with safety checks for paths outside the project root).
- A failed background sync shows a persistent banner with 查看/重试, and the
  last successful time survives later runs.
- Accounts can carry their own signature; the send path falls back to the
  global one.
- Compose recipient fields autocomplete from frequent senders/recipients.
- The conversation reader loads the whole subject thread from the backup, not
  only the messages currently on screen.
