---
'@zaclinley/dsh-mailharbor': minor
---

Reference-based conversations and a cleaner selection bar.

- Threading now reads In-Reply-To/References from the stored raw message
  instead of trusting the subject: unrelated mail with the same subject is no
  longer merged, and a parent with a different subject is included.
- New backup inserts record both headers; the thread endpoint also accepts the
  selected Message-ID and walks ancestors/descendants in SQLite.
- Legacy rows without the new columns fall back to header parsing, then to the
  old subject grouping.
- The selection bar wraps inside the list (no more vertical "已选 0 封"),
  uses an opaque background and fits in two rows at typical sidebar widths.
