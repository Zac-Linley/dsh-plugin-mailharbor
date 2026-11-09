---
'@zaclinley/dsh-mailharbor': patch
---

Make server-mode mail open from cache instead of waiting for IMAP.

- Folder lists and the last page per mailbox are persisted in the browser, so a
  new window paints the previous mail instantly and refreshes in the background.
- The active account's IMAP session is warmed at host startup and the INBOX
  first page is prefetched, removing the TLS/LOGIN wait from the first open.
- Hovering a server folder prefetches its first page (bounded, cancelled on the
  next hover).
- A "正在刷新…" indicator shows while cached mail is being refreshed.
- IMAP keepalive is every 150s so idle sessions survive shorter server timeouts.
