---
'@zaclinley/dsh-mailharbor': patch
---

Hide empty recipient lines in the reader.

- Expanded conversation cards only render the 收件人/抄送 block when addresses
  exist, and fall back to the loaded detail when the summary has none.
- The single-message reader no longer prints "收件人：—" either.
