---
'@zaclinley/dsh-mailharbor': patch
---

Recover missing recipients in expanded conversations.

- When the stored To list is empty, the reader parses To / Delivered-To /
  X-Original-To / Apparently-To from the raw message and uses that.
- If no recipient header exists at all (BCC-only or mailing list), the expanded
  card explains it instead of leaving the area blank.
