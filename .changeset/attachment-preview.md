---
'@zaclinley/dsh-mailharbor': patch
---

Attachment previews and drag/drop uploads.

- Clicking an image, PDF, plain text or JSON attachment opens an in-app preview
  with a download action instead of navigating away.
- Attachments are served inline only for safe preview types, with a sandbox CSP
  and `nosniff`; everything else keeps `Content-Disposition: attachment`.
- The composer accepts dropped files and pasted screenshots.
- Mail rows use `content-visibility` so very long folders skip off-screen layout.
