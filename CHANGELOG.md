# Changelog

## 0.1.0 - 2026-11-06

First public release: the core mail workspace, rebuilt on a real build pipeline.

### Added

- Multi-account mailbox model: per-account data directory, IMAP/SMTP settings, drafts and read state.
- Local backup engine: incremental IMAP → SQLite by UID range, UIDVALIDITY handling, batched
  transactions, content-addressed attachment files and a trigram full-text index.
- Read-only mail database view with paging, search and attachment streaming.
- Live server mode over IMAP (imapflow) with a recycled, serialized connection per account.
- Sending over SMTP through nodemailer: text + HTML alternatives, attachments, reply headers.
- Browser panel: folder/search list, reader (sandboxed HTML, remote images opt-in), composer with a
  rich-text toolbar, drafts and explicit send confirmation.
- DSH Settings section: accounts, connection checks, signature, read-on-open, list size, AI model.
- Sidebar entry with an unread badge.
- Agent tools: `mail_status`, `mail_list`, `mail_read`, `mail_search`, `mail_drafts`, `mail_draft`,
  `mail_backup`.
- Cross-platform credential storage: macOS Keychain, libsecret, Windows Credential Locker.
- Build pipeline (esbuild) that emits the DSH module-loader client bundle with the package id, plus a
  Vitest suite (unit, HTTP integration, bundle contract).
- GitHub Actions CI and a Changesets release workflow with npm provenance.

### Fixed (relative to the previous unpublished prototype)

- The client bundle now registers under the exact package name, which the DSH module loader keys
  boot-graph rows by; the previous bundle id no longer matched after the package rename.
- The backup engine asks the server only for UIDs above the last committed one instead of listing
  every UID on each run.
- SMTP is handled by nodemailer instead of a hand-written RFC 5322/MIME implementation.
