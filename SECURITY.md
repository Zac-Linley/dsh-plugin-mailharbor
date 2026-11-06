# Security Policy

## Supported versions

Only the latest minor release of `@zaclinley/dsh-mailharbor` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting on the repository (Security → Report a vulnerability) or email the maintainer listed in
`package.json`. Include the version, a description, and reproduction steps. You will receive an
acknowledgement within 72 hours.

## Security model

- **Credentials**: passwords are stored in the OS credential store (Keychain, libsecret, Credential
  Locker) or held in the Host process for the session. `config.json` never contains them.
- **Local data**: the backup database and attachments stay under `~/.dsh/mailharbor` and are opened
  with `0600` permissions where the platform supports it.
- **HTTP surface**: the API is mounted on DSH's loopback web server under `/mail-plugin/api`.
  State-changing requests from a foreign `Origin` are rejected with `403`; request bodies are capped.
- **HTML mail**: rendered in a `sandbox` iframe with `default-src 'none'`. Scripts, forms and remote
  images are blocked unless the user explicitly loads images.
- **Sending**: no agent tool can send mail. The panel requires an explicit confirmation step.
- **TLS**: IMAP and SMTP use `rejectUnauthorized: true`; plain submission ports require STARTTLS.
