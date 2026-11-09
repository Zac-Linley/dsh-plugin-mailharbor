---
'@zaclinley/dsh-mailharbor': minor
---

Attachments in threads, a roomier reader and collapsible AI cards.

- Thread reading is an accordion: only one message is open, collapsed cards are
  a single line, and the open body gets 55vh. Attachments appear per message.
- The reader header has an explicit "收件人/抄送" toggle; attachments are a
  compact chip strip.
- AI cards show a clamped preview; "展开全文" opens the complete answer in a
  dialog. Summaries can be expanded to a detailed version with one click.
- New setting: summary depth 简洁 / 标准 / 详细 (default 简洁); the prompt and
  deterministic trimming follow the chosen depth.
