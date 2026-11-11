---
'@zaclinley/dsh-mailharbor': minor
---

Remove OAuth2 and rebuild the shell for narrow windows.

- OAuth2 is gone: no auth mode, token storage, device/loopback flows or settings
  section. Accounts use passwords or app passwords again.
- Responsive shell: the account/folder column becomes a drawer below 1220px,
  the list and reader become one pane below 900px with a back button, the AI
  assistant overlays with a scrim below 1540px, and the reader's secondary
  actions collapse behind 更多 on phones.
- Fluid list width, wrapping topbar at 760px, full-width search, single-column
  settings grids, and a fixed sync popover on phones.
- Keyboard: `/` focuses search and Escape closes the popover, AI rail, drawer
  or reader in that order; empty searches offer a clear action.
- Thin scrollbars and larger touch targets on small screens.
