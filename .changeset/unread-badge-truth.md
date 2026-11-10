---
'@zaclinley/dsh-mailharbor': patch
---

Make the unread badge match the mail list.

- The badge now counts unread keys that still exist in the local backup instead
  of a raw key set or the server's unseen count, so it cannot show phantom mail.
- Backup mirrors IMAP flags into the local unread store: the recent window plus
  every unseen INBOX message, so unread mail is marked in the local list.
- The list gets a "未读 N" filter chip and a banner ("有 N 封未读 · 只看未读")
  for unread messages that are older than the first page.
- The sidebar badge refreshes every 30 seconds.
