---
'@zaclinley/dsh-mailharbor': minor
---

Replace the AI modals with a persistent per-mail AI workspace.

- A right-side rail holds every AI output as a card; cards survive closing the
  panel, switching mail and restarting DSH (stored in `ai-threads.json`).
- Conversion between steps: a summary produces a reply from its suggestions, a
  reply opens the composer or becomes a draft, a translation can be inserted.
- Free-form question box with earlier answers as context.
- Composer AI: draft / polish / shorten, translation, a version stack with
  restore, and debounced draft autosave so closing never loses text.
- Reader buttons now open the rail instead of separate dialogs.
