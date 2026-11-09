---
'@zaclinley/dsh-mailharbor': minor
---

Read a grouped conversation like a chat.

- Opening a message that belongs to a subject group shows the whole thread in
  the reader: each message is a card with sender, recipients and date; older
  messages collapse to a preview and expand on click.
- Expanding a message selects it, so reply/AI actions target that message.
- Bodies load lazily and reuse the existing cache.
