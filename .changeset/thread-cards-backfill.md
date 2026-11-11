---
'@zaclinley/dsh-mailharbor': minor
---

Readable thread cards and a reference index for old mail.

- Collapsed thread rows now show sender, snippet and a short timestamp; the
  recipient list only appears when a message is expanded. Sent messages show a
  compact "发给 N 人" badge instead of dumping addresses.
- Old backups are backfilled with In-Reply-To/References in the background on
  startup (300 rows per batch, `refs_indexed` prevents repeats); a Settings card
  shows progress and allows a manual rebuild.
- Cross-subject parents are now included for old mail as well (verified against
  a real archived reply whose title no longer matched its parent).
