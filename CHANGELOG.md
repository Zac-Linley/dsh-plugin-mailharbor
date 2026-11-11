# Changelog

## 0.16.0

### Minor Changes

- 15e68be: Remove OAuth2 and rebuild the shell for narrow windows.

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

## 0.15.0

### Minor Changes

- 729a56c: OAuth2 accounts, onboarding and config migration.

  - OAuth2: Google loopback with PKCE and Microsoft device-code login; access
    tokens refresh in the background and live in the OS keychain (not config).
  - Account creation accepts OAuth2 without a password; the account settings page
    gains an authorize / re-authorize / revoke card.
  - OAuth app configuration (client IDs) is editable in settings.
  - The empty state explains the three onboarding steps, including OAuth vs app
    passwords.
  - Export/import a small JSON profile: accounts (without secrets), signature,
    reading settings and OAuth app config; imports dedupe accounts by email.
  - Live OAuth needs your own client ID; refresh and device polling are covered
    by unit tests with mocked token endpoints.

## 0.14.0

### Minor Changes

- a39b9dc: Mirror drafts to the server's Drafts mailbox.

  - Explicit save and closing the composer append the draft to IMAP Drafts with
    `\Draft`, replacing the previous mirrored copy.
  - Discarding or sending a draft deletes its server copy as well.
  - The mirror is best-effort: offline saves stay local and the composer explains
    why the server copy is missing.

## 0.13.1

### Patch Changes

- 605d526: Project cleanup, sync errors, signatures, contacts and full threads.

  - Deleting a project can now also remove its folder and unregister the DSH
    workspace (with safety checks for paths outside the project root).
  - A failed background sync shows a persistent banner with 查看/重试, and the
    last successful time survives later runs.
  - Accounts can carry their own signature; the send path falls back to the
    global one.
  - Compose recipient fields autocomplete from frequent senders/recipients.
  - The conversation reader loads the whole subject thread from the backup, not
    only the messages currently on screen.

## 0.13.0

### Minor Changes

- 246bd54: Inline signature images and everyday mail actions.

  - Inline `cid:` images (signatures, embedded screenshots) are rewritten to
    data URLs in the reader for both server and archived mail, instead of
    appearing as attachments or broken images.
  - Star, archive, delete-to-trash and move-to-folder actions in the reader; the
    local backup is updated and the server is moved when the message still exists
    there.
  - Selection mode gains bulk read/unread/star/archive/delete.
  - Stars are stored locally and mirrored to IMAP `\Flagged`; the list shows a
    star marker.

## 0.12.2

### Patch Changes

- 7dbb04f: Make the unread badge match the mail list.

  - The badge now counts unread keys that still exist in the local backup instead
    of a raw key set or the server's unseen count, so it cannot show phantom mail.
  - Backup mirrors IMAP flags into the local unread store: the recent window plus
    every unseen INBOX message, so unread mail is marked in the local list.
  - The list gets a "未读 N" filter chip and a banner ("有 N 封未读 · 只看未读")
    for unread messages that are older than the first page.
  - The sidebar badge refreshes every 30 seconds.

## 0.12.1

### Patch Changes

- 1ce4fb8: Stop listing signature and embedded images as attachments.

  - Backup now records each attachment's Content-ID and Content-Disposition, and
    the server reader classifies inline/cid images as body content.
  - The attachment list filters inline images (disposition inline, cid without an
    explicit attachment disposition); old backups fall back to cid references and
    common `image001.png` names.
  - Real files (xlsx, pdf, docx, photos) are unaffected.

## 0.12.0

### Minor Changes

- 10fb651: One mail list: local first, automatic server sync.

  - The 本地备份 / 服务器实时 switch is gone. The panel opens the local backup
    immediately, then runs an incremental IMAP sync on open and every
    `read.pollSeconds` in the background.
  - The sync button shows a spinner while running and opens a small popover with
    progress, counters, recent log and start/stop, instead of a centred dialog.
  - The list refreshes when a sync finishes, so new mail just appears.
  - Many attachments collapse to the first three with a "+N 个附件" toggle.
  - Thread cards and AI cards no longer shrink when a thread is long.
  - AI cards expand the full answer inline inside the assistant rail (no separate
    dialog).

## 0.11.0

### Minor Changes

- 34cb550: Attachments in threads, a roomier reader and collapsible AI cards.

  - Thread reading is an accordion: only one message is open, collapsed cards are
    a single line, and the open body gets 55vh. Attachments appear per message.
  - The reader header has an explicit "收件人/抄送" toggle; attachments are a
    compact chip strip.
  - AI cards show a clamped preview; "展开全文" opens the complete answer in a
    dialog. Summaries can be expanded to a detailed version with one click.
  - New setting: summary depth 简洁 / 标准 / 详细 (default 简洁); the prompt and
    deterministic trimming follow the chosen depth.

## 0.10.1

### Patch Changes

- 1ed4656: Make server-mode mail open from cache instead of waiting for IMAP.

  - Folder lists and the last page per mailbox are persisted in the browser, so a
    new window paints the previous mail instantly and refreshes in the background.
  - The active account's IMAP session is warmed at host startup and the INBOX
    first page is prefetched, removing the TLS/LOGIN wait from the first open.
  - Hovering a server folder prefetches its first page (bounded, cancelled on the
    next hover).
  - A "正在刷新…" indicator shows while cached mail is being refreshed.
  - IMAP keepalive is every 150s so idle sessions survive shorter server timeouts.

## 0.10.0

### Minor Changes

- 7709209: More room for the mail body, scrollable summaries, and tighter AI summaries.

  - Reader header: recipients/cc collapse under a "详情" toggle; the meta row is a
    single line; attachments are a compact horizontal strip. Thread cards have a
    one-line header and a body capped at ~42vh instead of a fixed 380px.
  - Long AI summaries scroll inside their card (max-height + overflow), as do
    reply/answer cards.
  - Summary prompt is much stricter: total ≤180 characters, ≤3 action bullets,
    ≤5 key facts, ≤2 reply points only for direct recipients; the host also trims
    the output deterministically.

## 0.9.1

### Patch Changes

- e300651: Stop suggesting a reply to mail you were only copied on.

  - The summary prompt now receives your role (直接收件人 / 仅抄送 / 发件人 / 不在名单)
    and is told to skip reply suggestions unless you are a direct recipient.
  - For non-recipients the host also removes a reply-suggestion section the model
    still writes, so summaries stay deterministic.
  - The summary card hides "用这些要点回复" and shows "未建议回复" in that case.

## 0.9.0

### Minor Changes

- 550c459: Read a grouped conversation like a chat.

  - Opening a message that belongs to a subject group shows the whole thread in
    the reader: each message is a card with sender, recipients and date; older
    messages collapse to a preview and expand on click.
  - Expanding a message selects it, so reply/AI actions target that message.
  - Bodies load lazily and reuse the existing cache.

## 0.8.0

### Minor Changes

- a9601f1: Task editor polish, editable extraction, and faster mail reading.

  - The task editor is rebuilt: a four-way status switch, a due-date picker with
    今天/明天/本周五/下周一 shortcuts, colour-coded priority, a "这个事联系谁"
    field, a jump to the source mail, and delete in the editor.
  - Extracted tasks are editable before saving (title, due, priority, contact).
  - Message bodies are cached (client + host) and prefetched on row hover, so
    revisiting a mail is instant; the reader shows a loading state while fetching.
  - AI actions show a spinner and elapsed seconds (rail generation, AI search,
    composer rewrite) instead of a silent wait.

## 0.7.2

### Patch Changes

- 2206fb9: Clear project actions and a project manager.

  - The "加入项目" dialog is a two-mode choice: "加入已有项目" (no new project) or
    "新建项目" (creates one); the primary button says which action it performs.
  - A "项目" button in the mail toolbar opens a manager with rename, open folder
    and delete. Delete removes the MailHarbor record and unlinks its tasks; the
    project folder and DSH workspace stay on disk, as the dialog states.

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
