---
'@zaclinley/dsh-mailharbor': minor
---

Redesign the panel to match the DSH design system, and add a migration path from
the retired `dsh-plugin-mail` data directory.

- Buttons now use the shell's primary/ghost tokens (the old panel rendered a
  white-on-white send button in dark mode).
- Rows are real list items instead of buttons, so the shell's button layout no
  longer centers and squashes sender, subject and snippet.
- Reader, composer and settings use the same cards, spacing and icon set.
- Modals render in a themed portal; previously they escaped the panel's CSS
  variables and lost their background.
- `scripts/migrate-legacy.mjs` points an account at the old backup (or copies
  it), converts read-state keys and drafts, and copies the Keychain password.
