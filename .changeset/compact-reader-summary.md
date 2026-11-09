---
'@zaclinley/dsh-mailharbor': minor
---

More room for the mail body, scrollable summaries, and tighter AI summaries.

- Reader header: recipients/cc collapse under a "详情" toggle; the meta row is a
  single line; attachments are a compact horizontal strip. Thread cards have a
  one-line header and a body capped at ~42vh instead of a fixed 380px.
- Long AI summaries scroll inside their card (max-height + overflow), as do
  reply/answer cards.
- Summary prompt is much stricter: total ≤180 characters, ≤3 action bullets,
  ≤5 key facts, ≤2 reply points only for direct recipients; the host also trims
  the output deterministically.
