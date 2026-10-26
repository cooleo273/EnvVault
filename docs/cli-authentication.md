# CLI authentication

How `envvault login` signs a terminal in without a password, a copied browser
cookie, or a second identity system.

## 1. Why EnvVault brokers the flow

Neon Auth (Better Auth) offers browser sessions and JWTs for the web app. It
has no device authorization or other CLI flow, and its session cookie is not
meant to leave the browser. EnvVault therefore runs its own device
authorization, modelled on RFC 8628, on top of the existing web sign in:

- identity is still proven by Neon Auth, in the browser, with the person's
  normal sign in (including email verification and any later Neon Auth
  features);
- approval needs a fresh password confirmation (step up) through the existing
  `/auth/step-up` endpoint, so a stolen web session alone cannot approve a CLI;
- the CLI receives EnvVault issued tokens that work only on a short list of
  read routes (section 4).

This is a server side integration, not a separate account system: no
passwords, users or emails are stored by it. If Neon Auth later ships a
device flow, the broker can be replaced without changing the CLI's storage or
the API's authorization.

## 2. Flow

```
CLI                          API                              Browser (signed in)
 | POST /cli/device/authorize |                                     |
 |--------------------------->| device code (secret), user code     |
 |<---------------------------| BCDF-GHJK, 10 min, poll every 5 s   |
 | prints URL and code        |                                     |
 |                            |   GET /cli/authorize?code=BCDF-GHJK |
 |                            |<------------------------------------|
 |                            |   shows host, platform, version     |
 |                            |   POST /auth/step-up (password)     |
 |                            |   POST /cli/device/approve          |
 |                            |<------------------------------------|
 | POST /cli/device/token     |                                     |
 |--------------------------->| access + refresh token, once        |
 |<---------------------------|                                     |
```

- The device code is 32 random bytes; only its SHA-256 hash is stored.
- The user code uses 20 consonants (no vowels, no look alike characters),
  about 2.5 × 10¹⁰ combinations, and is valid for one pending request at a
  time.
- Polling faster than the interval returns `SLOW_DOWN`; the CLI adds five
  seconds. `AUTHORIZATION_PENDING`, `ACCESS_DENIED`, `EXPIRED_TOKEN` and
  `INVALID_GRANT` follow RFC 8628's meanings.
- A device code is exchanged once. The person compares the code in the
  browser with the terminal; the page warns that host name and platform are
  reported by the CLI and not verified.
- Starting, approving and refreshing are rate limited; approval is limited
  per user (10 per five minutes).

## 3. Tokens and sessions

|               | Format                      | Lifetime                      | Stored by the API                   |
| ------------- | --------------------------- | ----------------------------- | ----------------------------------- |
| Access token  | `evv_at_` + 32 random bytes | 1 hour                        | SHA-256 hash                        |
| Refresh token | `evv_rt_` + 32 random bytes | 30 days, rotates on every use | SHA-256 hash, plus the previous one |
| Session       |                             | at most 90 days from approval | `cli_sessions` row                  |

- Each refresh returns a new pair and invalidates the old refresh token. A
  reused old refresh token revokes the session (`auth.cli_refresh_reused`):
  someone else has a copy.
- A session ends on `envvault logout`, on revocation in Security settings
  (`/settings/security`, "CLI sessions"), on "sign out everywhere" and on a
  password change. Requests are also refused while the account's email is
  unverified.
- The CLI refreshes a minute before the access token expires. A refused
  refresh removes the stored credentials and asks for `envvault login`.

## 4. What a CLI token may do

CLI tokens are accepted only on routes marked `@AllowCliToken()`; every
other route answers `403 CLI_TOKEN_NOT_ALLOWED`, whatever the person's role.

- Read: `GET /users/me`, workspaces, projects, environments (list and get),
  secret metadata list, `GET /cli/sessions`.
- `POST …/environments/:id/runtime` (`envvault run`), `POST …/readiness`
  (`envvault doctor`), `POST …/export` (`envvault pull`).
- `POST /cli/sessions/current/revoke` (`envvault logout`).

Not allowed: anything that changes configuration, membership, roles or
grants; reveal; approving or denying another CLI login; key operations;
password confirmation. Normal authorization then applies on top: the token
carries the person's identity, and membership, project access, environment
grants, DENY, expiry and protected environment rules are evaluated per
request, so a lost permission takes effect immediately.

## 5. Storage on the developer's machine

- Default: the operating system credential store through `@napi-rs/keyring`
  (macOS Keychain, Windows Credential Manager, Linux Secret Service), one
  entry per API origin under the service `envvault-cli`.
- If no store is available the CLI stops and says so. It never falls back
  silently. `ENVVAULT_CREDENTIAL_STORE=file` opts into
  `<config dir>/credentials.json`, written with mode `0600` in a `0700`
  directory and refused when other users can read it.
- Tokens never go into `.envvault.json`, command line arguments, logs or
  terminal output.

## 6. Protected environments

Approval leaves the step up active for its window, and step up belongs to the
person, not to a browser session. A CLI command that hits `STEP_UP_REQUIRED`
links to `/cli/confirm`, where the person confirms their password in the
browser; the CLI then has the same short window. The CLI never collects
passwords.

## 7. Audit events

| Action                                             | When                                                       |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `auth.cli_login_approved`, `auth.cli_login_denied` | Decision in the browser                                    |
| `auth.cli_session_created`                         | Token issued                                               |
| `auth.cli_session_revoked`                         | Logout, web revocation, sign out everywhere                |
| `auth.cli_refresh_reused`                          | Old refresh token presented; session revoked               |
| `secret.runtime_loaded`                            | `envvault run` loaded values (ids and count, never values) |

## 8. Limitations and external items

- Neon Auth has no device flow (verified against the SDK and its
  documentation at the time of writing). The broker above is the replacement;
  nothing needs configuring in the Neon Console for it.
- The verification link uses `APP_BASE_URL` (or the first `CORS_ORIGINS`
  entry); it must be the web app's public address.
- Device and session tables need migration
  `20261025090000_cli_sessions`, and existing databases need
  `pnpm db:sync-catalog` for the `secret:runtime` permission.
- A malware infected developer machine can use whatever the CLI can; short
  access tokens, refresh rotation and revocation limit, but do not prevent,
  that.
