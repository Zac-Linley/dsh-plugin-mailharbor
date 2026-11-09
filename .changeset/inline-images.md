---
'@zaclinley/dsh-mailharbor': patch
---

Stop listing signature and embedded images as attachments.

- Backup now records each attachment's Content-ID and Content-Disposition, and
  the server reader classifies inline/cid images as body content.
- The attachment list filters inline images (disposition inline, cid without an
  explicit attachment disposition); old backups fall back to cid references and
  common `image001.png` names.
- Real files (xlsx, pdf, docx, photos) are unaffected.
