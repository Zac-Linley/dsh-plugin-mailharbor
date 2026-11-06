---
'@zaclinley/dsh-mailharbor': patch
---

Fix raw HTML in AI translation cards and silent connection checks.

- A translated email body is normalized: the card shows readable text, and
  "insert into reply" uses the translated body without the document wrapper.
- The account "check connection" button now shows a busy state and prints the
  result under the account it belongs to; it previously only appeared while the
  row was expanded in edit mode.
