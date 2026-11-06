---
'@zaclinley/dsh-mailharbor': minor
---

Add AI assistance, drafts and a unified inbox.

- AI summary in Chinese with four sections (结论 / 需要你做什么 / 关键信息 / 建议回复要点).
- AI reply with an optional instruction and 中/EN output; preview before inserting, sending still needs confirmation.
- One-click translation of the compose body, with an inline confirm step instead of a native dialog.
- Writing style learned from up to 100 sent messages, stored per account, injected into AI replies and editable in settings.
- Drafts folder: save, list, reopen for editing, delete.
- Unified inbox across accounts with a per-message account badge.
- Server-mode paging through IMAP sequence ranges; the unread badge now sums every account.
- Demo data seeder (`npm run seed:demo`) plus public README screenshots; no real mail is used.
