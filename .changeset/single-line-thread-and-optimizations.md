---
'@zaclinley/dsh-mailharbor': minor
---

Single-line thread cards and a batch of interaction/performance fixes.

- Collapsed thread rows are now truly one line: sender, unread dot, attachment
  icon, recipient count and time; the snippet line is gone.
- Hover prefetches both the message detail and its conversation.
- Message bodies get `loading="lazy"` images; attachments are cached privately
  for a day instead of `no-store`.
- Search terms are highlighted in sender/subject/snippet.
- Modals trap Tab focus, restore the previous focus and announce toast text.
- Settings can run `PRAGMA optimize` + FTS compaction + WAL checkpoint.
- Conversation subjects now have a normalized key table (CJK subjects could not
  be matched by the trigram FTS index); it is backfilled with the reference
  index and new mail writes it at backup time.
