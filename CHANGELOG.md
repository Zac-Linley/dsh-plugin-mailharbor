# Changelog

## 0.7.1

### Patch Changes

- 841e14b: Add a mail to an existing project from the reader.

  - The reader toolbar gains "加入项目": pick an existing project or create a new
    one and the current mail is linked immediately.
  - Multi-select ("选择") is available in server mode too, so several mails can
    be added to a project from the live view.

## 0.7.0

### Minor Changes

- 71eb08a: Mail search, conversation grouping and a four-column task board.

  - Sent folders show the recipients instead of the sender.
  - The mail list groups messages by conversation title; a count chip expands the thread.
  - The search box is an AI search: a sentence is parsed into sender/keywords/dates and
    searched across local folders, with a timeout fallback to plain search.
  - The account header toggles the account/folder sidebar; the unified inbox is gone and
    the top-bar add-account button no longer occupies space.
  - Project directories can be picked in Finder / the file manager.
  - The task board is four columns (待处理 / 进行中 / 已完成 / 终止), without the progress
    summary, with project filtering and drag & drop.
  - CalDAV remains removed; tasks stay local.

## 0.6.0

### Minor Changes

- 4367e79: Mailbox sidebar, Kanban tasks and a faster server mode.

  - The mail panel gains a left column with the unified inbox, accounts and the
    selected account's folders; server realtime is now the default view.
  - Server mail opens much faster: the folder list is cached, the IMAP session is
    kept warm with a periodic NOOP, pages are cached briefly, and folder counts
    are filled from SELECT instead of issuing one STATUS per folder.
  - The task panel is a Kanban board (待处理 / 进行中 / 已完成) with drag & drop,
    richer cards and a redesigned task editor.
  - CalDAV support was removed; tasks are local-only.

## 0.5.1

### Patch Changes

- c12db95: - Projects now appear in the DSH Workspaces sidebar: the plugin waits for the
  optional `workspaceRegistry` service and registers the project workspace
  (and its starting session) instead of leaving a folder-only project.
  - CalDAV gets a dedicated "任务与 CalDAV" card in MailHarbor settings: account
    picker, address, username, app password, calendar path, save and "sync now",
    plus the last sync state.

## 0.5.0

### Minor Changes

- 49246d5: Mail-to-project workspaces, a task panel, Markdown AI answers and CalDAV.

  - Projects: from the AI rail, create a project folder with `BRIEF.md` and the
    whole AI conversation, optionally starting a DSH session in that directory.
    Append later AI records at any time, and add more mails from the list.
    The default project root lives in Settings.
  - Tasks: a separate sidebar panel with manual CRUD, filters, per-project
    progress, source-mail links, and AI extraction from the current mail (review
    before saving). Optional CalDAV VTODO sync per account.
  - AI answers render Markdown (headings, lists, code, links) instead of raw text.
  - Settings no longer clips its cards, and a translated mail card shows text.

## 0.4.1

### Patch Changes

- 3ce3ed1: Fix raw HTML in AI translation cards and silent connection checks.

  - A translated email body is normalized: the card shows readable text, and
    "insert into reply" uses the translated body without the document wrapper.
  - The account "check connection" button now shows a busy state and prints the
    result under the account it belongs to; it previously only appeared while the
    row was expanded in edit mode.

## 0.4.0

### Minor Changes

- 4980d11: Replace the AI modals with a persistent per-mail AI workspace.

  - A right-side rail holds every AI output as a card; cards survive closing the
    panel, switching mail and restarting DSH (stored in `ai-threads.json`).
  - Conversion between steps: a summary produces a reply from its suggestions, a
    reply opens the composer or becomes a draft, a translation can be inserted.
  - Free-form question box with earlier answers as context.
  - Composer AI: draft / polish / shorten, translation, a version stack with
    restore, and debounced draft autosave so closing never loses text.
  - Reader buttons now open the rail instead of separate dialogs.

## 0.3.0

### Minor Changes

- 70cb32a: Add AI assistance, drafts and a unified inbox.

  - AI summary in Chinese with four sections (结论 / 需要你做什么 / 关键信息 / 建议回复要点).
  - AI reply with an optional instruction and 中/EN output; preview before inserting, sending still needs confirmation.
  - One-click translation of the compose body, with an inline confirm step instead of a native dialog.
  - Writing style learned from up to 100 sent messages, stored per account, injected into AI replies and editable in settings.
  - Drafts folder: save, list, reopen for editing, delete.
  - Unified inbox across accounts with a per-message account badge.
  - Server-mode paging through IMAP sequence ranges; the unread badge now sums every account.
  - Demo data seeder (`npm run seed:demo`) plus public README screenshots; no real mail is used.

## 0.2.1

### Patch Changes

- 7f5a956: Adapt the sidebar unread badge to the shell: a compact accent pill at the icon
  corner instead of a white blob that covered the envelope (the old badge used
  `--dsw-alias-brand-primary`, which is near-white in the dark theme).

## 0.2.0

### Minor Changes

- b9e52c2: Redesign the panel to match the DSH design system, and add a migration path from
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
