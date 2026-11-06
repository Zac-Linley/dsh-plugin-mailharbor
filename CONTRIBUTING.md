# Contributing to MailHarbor

Thanks for helping. This project is a DSH plugin, so a change must keep three contracts working:
the Host entry, the browser bundle, and the package manifest.

## Development setup

```bash
git clone https://github.com/Zac-Linley/dsh-plugin-mailharbor.git
cd dsh-plugin-mailharbor
npm ci
npm run build
npm test
```

Node **24.9+** is required (`node:sqlite` and the DSH runtime baseline). The DSH desktop app ships a
compatible Node at `Contents/Resources/runtime`.

For live UI work against a running DSH:

```bash
npm run dev                                   # rebuilds lib/ on change
dsh plugin --profile desktop add link:$PWD
```

DSH hot-reloads a rebuilt client bundle; Host changes need a plugin reload.

## Before opening a pull request

```bash
npm run check     # typecheck + lint + build + tests + pack check
npm run format    # Prettier
```

Add tests for behaviour, not for implementation details:

- Pure logic and stores: `test/*.test.ts` with temporary directories.
- HTTP/API changes: extend `test/api.test.ts` (it boots the real handler over a loopback server).
- Bundle/contract changes: extend `test/bundle.test.ts`.

Never commit real mailbox data, passwords, `.env` files, or `~/.dsh/mailharbor`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `perf:`, `chore:`. Keep the subject in the imperative mood and under 72 characters.

## Releases

1. `npx changeset` — select the bump (`patch` / `minor` / `major`) and describe the user-visible change.
2. Commit the generated `.changeset/*.md` file with the PR.
3. On merge to `main`, the release workflow opens or updates a **Version Packages** PR.
4. Merging that PR runs `changeset version`, pushes the `vX.Y.Z` tag, and publishes to npm with
   provenance.

The repository needs an `NPM_TOKEN` secret with publish rights for `@zaclinley/*`.

## Design rules

- **No secrets in the config file.** Passwords live in the OS credential store or the session.
- **The backup database is read-only** for the panel and tools.
- **No tool sends mail.** Sending is a user action in the panel, always confirmed.
- **No new runtime `@deepseek-ai/*` dependency.** Type contracts are declared locally in
  `src/host/dsh.ts` and `src/client/dsh.ts`.
- **The client bundle id must equal the package name.** The DSH loader keys boot-graph rows that way.
