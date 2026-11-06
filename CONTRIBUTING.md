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

### Publish credentials (one-time setup)

Releases publish with npm **Trusted Publishing** (OIDC); the workflow holds no npm token.
Register the publisher once, before the first automated release:

1. npmjs.com → package `@zaclinley/dsh-mailharbor` → Settings → Trusted publishing → GitHub Actions
2. Organization/user `Zac-Linley`, repository `dsh-plugin-mailharbor`, workflow `release.yml`,
   environment left empty

No `NPM_TOKEN` repository secret is needed — do not add one. The workflow requests
`id-token: write`, omits `registry-url` on `actions/setup-node` (its placeholder `.npmrc`
would stop the OIDC exchange), and upgrades npm to the 11.x line because trusted publishing
requires npm >= 11.5.1.

The first version (0.1.0) was published manually: npm only accepts a trusted publisher for a
package that already exists.

## Design rules

- **No secrets in the config file.** Passwords live in the OS credential store or the session.
- **The backup database is read-only** for the panel and tools.
- **No tool sends mail.** Sending is a user action in the panel, always confirmed.
- **No new runtime `@deepseek-ai/*` dependency.** Type contracts are declared locally in
  `src/host/dsh.ts` and `src/client/dsh.ts`.
- **The client bundle id must equal the package name.** The DSH loader keys boot-graph rows that way.
