---
'@zaclinley/dsh-mailharbor': minor
---

Mirror drafts to the server's Drafts mailbox.

- Explicit save and closing the composer append the draft to IMAP Drafts with
  `\Draft`, replacing the previous mirrored copy.
- Discarding or sending a draft deletes its server copy as well.
- The mirror is best-effort: offline saves stay local and the composer explains
  why the server copy is missing.
