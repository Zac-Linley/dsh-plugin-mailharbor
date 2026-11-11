# MailHarbor

[![CI](https://github.com/Zac-Linley/dsh-plugin-mailharbor/actions/workflows/ci.yml/badge.svg)](https://github.com/Zac-Linley/dsh-plugin-mailharbor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zaclinley/dsh-mailharbor.svg)](https://www.npmjs.com/package/@zaclinley/dsh-mailharbor)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4B67B4)](https://github.com/Zac-Linley/dsh-plugin-mailharbor)

**A multi-account IMAP/SMTP mail workspace for [DeepSeek Harness](https://github.com/Zac-Linley/dsh-plugin-mailharbor).**

MailHarbor adds a **Mail** entry to the DSH sidebar and a full mail workspace to the main panel:
browse a local backup or live server mail, search, read HTML safely, write and send, keep drafts,
and let the model read mail through `mail_*` tools. Every account keeps its own database, drafts
and read state.

- Package: `@zaclinley/dsh-mailharbor`
- Requirements: **DSH `>=0.2.2-0 <0.3.0`**, Node **>=24.9** (the runtime bundled with DSH is fine)
- License: MIT
- Status: **v0.15.0 — local-first mail workspace with background IMAP sync, OAuth2, AI search, projects and a Kanban task board**.

## Features

| Area        | What you get                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth2       | Google loopback + PKCE and Microsoft device-code flows; tokens in the OS keychain, refreshed in the background (bring your own client ID) |
| Accounts     | Any IMAP/SMTP mailbox; password, app password or OAuth2; per-account data directory; accounts and folders in the left column |
| Local-first | Opens from the local SQLite backup instantly, then syncs new mail in the background; progress popover with start/stop                                         |
| Browse      | Collapsible account/folder column, paging, subject conversations loaded across the whole backup, AI search over the local index                               |
| Actions     | Star, archive, delete-to-trash, move to any folder; bulk read/unread/star/archive/delete                                                                      |
| Reader       | Sandboxed HTML with a strict CSP, inline cid images as data URLs, remote images blocked, plain-text fallback, attachment download |
| Compose     | Rich text, attachments, reply/reply-all/forward with `In-Reply-To` and `References`, contact autocomplete, per-account signatures, explicit send confirmation |
| Drafts       | Local drafts mirrored to IMAP Drafts on save/close, cleaned up on discard and send |
| AI          | Per-mail workspace: summary (brief/standard/detailed), reply, translation, Q&A, writing style; inline expansion; AI search; compose draft/polish/shorten      |
| Projects    | Project folder (`BRIEF.md`, `CONVERSATION.md`) registered in DSH Workspaces; append AI records, add mails, open in Finder; delete folder/workspace when asked |
| Tasks       | Kanban board (待处理 / 进行中 / 已完成 / 终止) with due/priority/owner/project, source-mail links and AI extraction                                           |
| Credentials | macOS Keychain, libsecret, Windows Credential Locker; OAuth tokens stored separately and refreshed in the background; secrets never enter `config.json`       |
| Migration   | Export/import a JSON profile: accounts without secrets, signature, reading settings and OAuth app config                                                      |
| Agent tools | `mail_status`, `mail_list`, `mail_read`, `mail_search`, `mail_drafts`, `mail_draft`, `mail_backup`                                                            |
| Migration    | Export/import a JSON profile: accounts without secrets, signature, reading settings and OAuth app config |
| Settings     | DSH Settings → MailHarbor: accounts, OAuth app IDs, checks, signature, reading, list size, AI model and writing style, project root |

## Screenshots

| Unified inbox                                                                                                        | Reader                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ![Unified inbox](https://raw.githubusercontent.com/Zac-Linley/dsh-plugin-mailharbor/main/docs/screenshots/panel.png) | ![Reader](https://raw.githubusercontent.com/Zac-Linley/dsh-plugin-mailharbor/main/docs/screenshots/reader.png) |

| AI workspace (per mail, persisted)                                                                                         | Composer AI with version stack                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ![AI workspace](https://raw.githubusercontent.com/Zac-Linley/dsh-plugin-mailharbor/main/docs/screenshots/ai-workspace.png) | ![AI compose](https://raw.githubusercontent.com/Zac-Linley/dsh-plugin-mailharbor/main/docs/screenshots/ai-compose.png) |

![Writing style learned from sent mail](https://raw.githubusercontent.com/Zac-Linley/dsh-plugin-mailharbor/main/docs/screenshots/settings-ai.png)

> Screenshots use fabricated demo data (`node scripts/seed-demo.mjs`), not a real mailbox.

## Install

```bash
dsh plugin --profile desktop add @zaclinley/dsh-mailharbor
```

Reload the app window (or restart DSH) once so the browser bundle is picked up. The bundle layer in
`cordis.patch.yml` inserts the `mailharbor` row automatically.

From a local checkout:

```bash
git clone https://github.com/Zac-Linley/dsh-plugin-mailharbor.git
cd dsh-plugin-mailharbor
npm ci && npm run build
dsh plugin --profile desktop add link:$PWD
```

> If you previously installed the older `dsh-plugin-mail` package, remove that row first — both
> plugins claim the `/mail-plugin` HTTP prefix, and only one can own it.

## First run

1. Open the **MailHarbor** panel from the sidebar.
2. Add an account: address + password (or app password). **Advanced** lets you set IMAP/SMTP hosts,
   ports and TLS. The account is verified against IMAP before it is saved.
3. The list opens from the local backup immediately; the sync indicator pulls new mail in the background (and every poll interval).
4. Press **Write** to compose. New mail appears after the next background sync.

### Gmail, Outlook, and other providers

- Gmail: use OAuth2 (add a Google OAuth client ID in Settings) or an **app password** with IMAP
  enabled and 2-Step Verification.
- Microsoft 365: use OAuth2 with your tenant's client ID; basic auth/app passwords only work if
  the tenant still allows IMAP AUTH.
- Yahoo: app password. Self-hosted: any IMAP/SMTP endpoints with STARTTLS or implicit TLS.

## Migrating from `dsh-plugin-mail`

The package was renamed and the data root moved (`~/.dsh/mail-plugin` → `~/.dsh/mailharbor`).
A migration script ships with the package:

```bash
# preview what would change
node node_modules/@zaclinley/dsh-mailharbor/scripts/migrate-legacy.mjs --dry-run

# point the new account at the existing backup (no copy; instant, keeps the large DB in place)
node node_modules/@zaclinley/dsh-mailharbor/scripts/migrate-legacy.mjs

# or make a self-contained copy under the new data root
node node_modules/@zaclinley/dsh-mailharbor/scripts/migrate-legacy.mjs --copy
```

It matches accounts by email, repoints `dataDir`, converts read-state keys and drafts to the new
shapes, and copies the macOS Keychain password to the new service name. OAuth2 accounts are skipped
until OAuth support ships. Restart DSH afterwards so the Host reopens the database.

## Data and privacy

| What                    | Where                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Plugin state            | `~/.dsh/mailharbor` (`DSH_MAILHARBOR_DATA_DIR`)                                      |
| Config (no secrets)     | `~/.dsh/mailharbor/config.json` (`DSH_MAILHARBOR_CONFIG`)                            |
| Per-account mail backup | `~/.dsh/mailharbor/accounts/<id>/mail.db` + `attachments/`                           |
| Drafts / read state     | `<account>/drafts.json`, `<account>/read-state.json`                                 |
| Passwords               | OS credential store only; `DSH_MAILHARBOR_PASSWORD_<ACCOUNT_ID>` for scripted setups |

- The backup database is opened **read-only** by the panel and tools; only the backup engine writes.
- HTML mail renders in a `sandbox` iframe with `default-src 'none'`; scripts and forms never run, and
  remote images are blocked until you ask for them.
- The HTTP API listens on DSH's own loopback server and rejects cross-site writes (`403`).
- `mail_*` tools never send mail: there is no `mail_send` tool. Sending is a user action in the panel.
- AI calls go through DSH's own `ctx.llm`; nothing is sent when AI is off. The writing style stores only the
  distilled profile, not the sent mail it was learned from.
- AI cards are stored per account in `ai-threads.json` (50 threads / 50 cards each, capped, with a clear button).

## Agent tools

| Tool                         | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `mail_status`                | Account, login state, local total, last backup         |
| `mail_list`                  | List local or server messages (folder, keyword, limit) |
| `mail_read`                  | Read one message, with attachment metadata             |
| `mail_search`                | Full-text search over the local backup                 |
| `mail_drafts` / `mail_draft` | List and write local drafts — never sends              |
| `mail_backup`                | Start an incremental backup in the background          |

## Development

```bash
npm ci
npm run build        # lib/index.js (Host) + lib/client.js (browser bundle)
npm run dev          # rebuild on change; DSH hot-reloads the bundle
npm run typecheck
npm run lint
npm test             # Vitest: unit + HTTP integration + bundle contract
npm run check        # typecheck + lint + build + test + pack check
```

Architecture:

```
src/host/       Node half: config, credentials, IMAP, SMTP, SQLite, backup, HTTP API, tools
src/client/     Browser half: panel, reader, composer, settings, styles
src/shared/     Wire types shared by both halves
scripts/        build.mjs (esbuild), sync-version.mjs
test/           Vitest suites (fixtures are generated, no real mailbox needed)
```

The browser bundle is built by esbuild into the DSH module-loader format
(`window.__ModuleLoader__.load({ id, factory })`), with `id` equal to the package name. React and
React DOM come from the shell's shared module table and are never bundled.

### Releasing

Versions are managed with [Changesets](https://github.com/changesets/changesets):

```bash
npx changeset          # describe the change and pick a bump
npm run version        # writes CHANGELOG.md and bumps package.json + VERSION constants
```

CI publishes from `main` through `.github/workflows/release.yml`; the `NPM_TOKEN` repository secret
must be able to publish `@zaclinley/*`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

| Version   | Scope                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| **0.1.x** | Core mail workspace, backup, tools, settings, publishing pipeline               |
| 0.2       | UI overhaul, migration from `dsh-plugin-mail`, installer polish                 |
| 0.3       | Drafts, unified inbox, server paging, AI summary/reply/translate, writing style |
| 0.4       | Persistent AI workspace, composer version stack                                 |
| 0.5       | Projects from mail, task panel                                                  |
| 0.6       | Mailbox sidebar, Kanban tasks, faster server browsing                           |
| 0.7       | AI search, conversation grouping, folder picker, four-column task board         |
| 0.8       | OAuth2 + XOAUTH2 (Gmail loopback/PKCE, Microsoft device code), token refresh    |
| Later     | Reports, export/import, onboarding, richer attachments                          |

## Star history

If MailHarbor is useful, a star helps other DSH users find it.

## License

[MIT](LICENSE) © 2026 Zac Linley
