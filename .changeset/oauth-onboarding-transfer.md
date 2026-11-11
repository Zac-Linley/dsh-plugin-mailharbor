---
'@zaclinley/dsh-mailharbor': minor
---

OAuth2 accounts, onboarding and config migration.

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
