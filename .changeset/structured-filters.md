---
'@zaclinley/dsh-mailharbor': minor
---

Structured mail filters.

- Filter the list by sender name/address, a start and end date, and whether the
  mail has attachments; combine with the existing unread filter.
- The filter popover opens next to the toolbar and stays inside the panel at
  phone widths; 重置 clears all conditions.
- Filtering happens in SQLite, so it works across the whole local backup rather
  than only the loaded page.
