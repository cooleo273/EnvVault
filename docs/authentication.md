# Authentication and authorization

EnvVault splits identity from access:

- **Neon Auth authenticates.** It is Neon's managed Better Auth service and stores users,
  password hashes, sessions and verification tokens in the Neon-managed `neon_auth`
  schema. EnvVault has no password table, password hashing or second identity provider.
- **EnvVault authorizes.** Workspaces, memberships, roles, permissions, token revocation
  and step-up grants live in EnvVault's own tables (`public` schema, Prisma migrations).
  They point to Neon Auth users by their stable user ID (`users.auth_user_id` = JWT `sub`).

Application migrations never create, alter or read `neon_auth`.

## 1. Architecture

```
Browser ──(HTTP-only __Secure-neon-auth.* cookies)──▶ Next.js (apps/web)
                                                      │  @neondatabase/auth SDK
                                                      │  ├─ /api/auth/*  → Neon Auth (sign-in, sign-up, …)
                                                      │  └─ auth.token() → short-lived JWT (EdDSA)
                                                      ▼
                                   Authorization: Bearer <JWT>
                                                      ▼
                                           NestJS API (apps/api)
                                           ├─ verifies JWT against Neon's JWKS
                                           ├─ maps sub → EnvVault user (JIT provisioning)
                                           └─ authorizes against memberships in PostgreSQL
```

- **Backend-for-frontend.** The browser holds only Neon Auth's HTTP-only, `Secure`,
  `SameSite=Strict` cookies. Browser JavaScript never sees a JWT. On each API call the
  Next.js server mints a fresh JWT with `auth.token()` and sends it as a bearer token
  (`apps/web/src/lib/api/server-api.ts`).
- **The API accepts bearer tokens only.** It does not read Neon cookies and does not use
  the Better Auth NestJS integration: that integration expects a self-hosted Better Auth
  instance with database access, which managed Neon Auth does not provide.

### Routes

| Area                                                                             | Who                    | Enforced by                                                             |
| -------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `/`, `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` | anyone                 | none (`/auth/*` URLs from Phase 0 redirect permanently)                 |
| `/invite`                                                                        | anyone                 | Asks anonymous visitors to sign in; the API checks the invitation       |
| `/dashboard`, `/onboarding`, `/workspaces/**`, `/settings/**`, other app routes  | signed in and verified | `src/proxy.ts` (redirect), then `requireVerifiedUser` in the app layout |
| `/api/auth/*`                                                                    | proxied to Neon Auth   | SDK handler                                                             |
| API `/api/v1/health/*`                                                           | anyone                 | `@Public()`                                                             |
| Any other API route                                                              | depends on the route   | global guards (below)                                                   |

After sign-in, users go to `redirectTo` if it is a safe same-origin path (`safeRedirectPath`
rejects other origins and the auth pages themselves); otherwise to `/dashboard`, which
continues to onboarding when the user has no workspace. Sign-up keeps `redirectTo` through
email verification in an HTTP-only cookie, which is validated again on use.

### Account features (all through supported Neon Auth endpoints)

| Feature            | Neon Auth call (server-side SDK)                                              | EnvVault follow-up                               |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Profile name       | `updateUser({ name })` (`/update-user`)                                       | Cached in `users.display_name` from the next JWT |
| Password change    | `changePassword({ currentPassword, newPassword, revokeOtherSessions: true })` | `POST /auth/tokens/revoke` (`password_changed`)  |
| List sessions      | `listSessions()`                                                              | Session tokens never reach the browser           |
| End one session    | `revokeSession({ token })` (token looked up server-side)                      | `POST /auth/tokens/revoke` (`sessions_revoked`)  |
| End other sessions | `revokeOtherSessions()`                                                       | same                                             |
| Change email       | not offered yet                                                               | —                                                |

A password change replaces the session cookie within the same request. The API token used
for the follow-up revocation is therefore minted **before** the change
(`clientWithCurrentToken`). Minting afterwards would read the old, revoked cookie.

The web checks are for routing and UX only. Every authorization decision is made by the
API.

## 2. Verified Neon Auth facts

Checked against Neon's documentation and the installed SDK source
(`@neondatabase/auth@0.6.0-beta`, which pins `better-auth@1.7.6`) on 2026-10-19:

| Fact                                                                                                                                                                                      | Source                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| JWKS at `<Auth URL>/.well-known/jwks.json`; keys are EdDSA (Ed25519)                                                                                                                      | [JWT plugin](https://neon.com/docs/auth/guides/plugins/jwt.md)                                                            |
| `iss` and `aud` are both the **origin** of the Auth URL                                                                                                                                   | JWT plugin docs, confirmed against issued tokens                                                                          |
| JWTs expire after **15 minutes**; custom claims are not supported                                                                                                                         | JWT plugin docs                                                                                                           |
| Server `auth.token()` calls `GET /token` and mints a new JWT on every call                                                                                                                | [Next.js server reference](https://neon.com/docs/auth/reference/nextjs-server.md), SDK source                             |
| Cookies use the `__Secure-neon-auth.` prefix; `session_data` is HMAC-signed with `NEON_AUTH_COOKIE_SECRET` and cached for 5 minutes                                                       | Next.js server reference, SDK source                                                                                      |
| Each Neon branch has its own Auth URL, users and sessions                                                                                                                                 | [Branching authentication](https://neon.com/docs/auth/branching-authentication.md)                                        |
| Sign-in, sign-up, email OTP verification and password reset (`requestPasswordReset`, `resetPassword`)                                                                                     | [Authentication flow](https://neon.com/docs/auth/authentication-flow.md), [overview](https://neon.com/docs/auth/overview) |
| The SDK maps Better Auth error codes to Supabase-style ones (`invalid_credentials`, `email_not_confirmed`, `over_request_rate_limit`); transport failures are `NETWORK_*` with status 502 | SDK source                                                                                                                |
| Better Auth rejects requests that carry cookies or Fetch-Metadata headers without a trusted `Origin`. Node's `fetch` always sends `Sec-Fetch-Mode`                                        | better-auth source. This is why the API sends `AUTH_TRUSTED_ORIGIN` when it re-verifies a password                        |
| `localhost` is pre-trusted; production domains must be added as trusted domains                                                                                                           | Neon Console                                                                                                              |

**Key rotation.** The API uses `jose`'s `createRemoteJWKSet`:

- Keys are cached for 10 minutes.
- A token signed with an unknown `kid` triggers a refetch, at most once every 30 seconds.
- Each fetch times out after 3 seconds.

This means a newly rotated key is accepted within seconds and a retired key stops being
accepted once the cache refreshes. JWKS failures return **503 `AUTH_UNAVAILABLE`**, never
"allow".

## 3. Token verification (API)

`apps/api/src/auth/neon-token.verifier.ts`. A request is authenticated only if all of
these hold:

1. The `Authorization: Bearer <token>` header is present and well-formed.
2. The signature verifies against the configured branch's JWKS, with algorithm `EdDSA`
   only.
3. `iss` equals the origin of `NEON_AUTH_BASE_URL` and `aud` equals `NEON_AUTH_AUDIENCE`
   (which defaults to the same origin).
4. `exp` is in the future and `iat` is at most `AUTH_MAX_TOKEN_AGE_SECONDS` old (5-second
   clock tolerance).
5. The claims have the expected shape: `sub` matches `id`, and the token carries `email`,
   `emailVerified` and `name`.
6. The user is not `banned` in Neon Auth (otherwise 403 `ACCOUNT_DISABLED`).
7. The EnvVault profile is `ACTIVE` and not deleted.
8. The token was issued at or after the user's revocation boundary (otherwise 401
   `TOKEN_REVOKED`).
9. The email is verified (otherwise 403 `EMAIL_NOT_VERIFIED`). Only `GET /users/me` and logout allow
   unverified users.

`NEON_AUTH_JWKS_URL` may override the JWKS location, but it must have the same origin as
`NEON_AUTH_BASE_URL`. Without this rule, keys from one branch could validate tokens
claiming another branch's issuer.

## 4. Authorization (default deny)

Global guards run in this order: rate limiting, then `AuthenticationGuard`, then
`AuthorizationGuard`. Each route must declare one of:

| Decorator                                       | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `@Public()`                                     | No authentication (health checks only)                                  |
| `@Authenticated()`                              | Any verified user; data is scoped to `request.principal` in the handler |
| `@RequireWorkspacePermission('workspace:read')` | ACTIVE membership in `:workspaceId` whose role grants the permission    |
| `@RequireStepUp()`                              | Additionally, a fresh password re-verification (see section 6)          |

A route without a declaration is refused with 403, and an error is logged.

- **Client-supplied IDs are never evidence.** The user identity comes only from the
  verified token's `sub`.
- A workspace ID in the URL is a lookup key. The guard grants access only after loading
  the caller's own membership in that workspace.
- Non-members get **404**, whether or not the workspace exists, so workspace IDs cannot
  be probed.
- Members without the required permission get **403**.

## 5. Sessions, logout and revocation

A Neon JWT stays cryptographically valid until it expires (at most 15 minutes), even after
its session ends. EnvVault closes that gap in its own tables:

| Action                 | Neon Auth                                    | EnvVault API                                                                                                               |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sign out               | `signOut()` ends the session, clears cookies | `POST /auth/logout {scope:"current"}` sets `auth_token_revocations.not_before = now` and clears step-up grants             |
| Sign out everywhere    | `revokeSessions()` then `signOut()`          | `POST /auth/logout {scope:"all"}` does the same with reason `LOGOUT_ALL_DEVICES`                                           |
| Password change        | `changePassword(…, revokeOtherSessions)`     | `POST /auth/tokens/revoke {reason:"password_changed"}` revokes every token issued until now                                |
| End other sessions     | `revokeSession` / `revokeOtherSessions`      | `POST /auth/tokens/revoke {reason:"sessions_revoked"}`                                                                     |
| Account banned in Neon | sessions end                                 | `banned` claim gives 403 immediately; tokens minted before the ban are rejected only once they expire (at most 15 minutes) |

- The web calls the API **before** ending the Neon session, so the request is still
  authenticated.
- `not_before` only moves forward (`GREATEST`). A replayed or delayed logout cannot shorten
  a revocation.
- **JWT `iat` has 1-second granularity.** A token minted in the same second as a logout is
  rejected too. After signing back in, the web retries once after about a second
  (`withApi`, on `TOKEN_REVOKED`).
- "Sign out" revokes API tokens for **all** of the user's devices for the rest of their
  lifetime. The other devices mint new tokens on their next request, because their Neon
  sessions remain valid. This trade-off exists because Neon JWTs carry no session ID.

## 6. Step-up verification (sensitive actions)

Deleting a workspace requires the `workspace:delete` permission **and** a step-up grant:

1. The user re-enters their password in the confirmation dialog.
2. The web calls `POST /auth/step-up`. The API re-verifies the password with Neon Auth
   (`POST <Auth URL>/sign-in/email`) and checks that the returned user ID equals the
   token's `sub`.
3. The API immediately signs that temporary session out, sending the trusted `Origin`.
4. On success the API stores an `auth_step_up_grants` row valid for
   `AUTH_STEP_UP_TTL_SECONDS` (default 10 minutes, at most 1 hour by a CHECK constraint).
5. Failures are rate-limited (5 per minute), audited, and return 403 `STEP_UP_FAILED`.
   Neon outages return 503.

The password is never stored or logged.

## 7. Environments

Development and production **must** use different Neon branches. Each branch has its own
Auth URL, users, sessions and signing keys, so a token from one environment cannot be
used in the other. Use a different `NEON_AUTH_COOKIE_SECRET` per environment.

In production (`NODE_ENV=production`), both apps refuse `http://` and local Auth URLs. The
web app also refuses a local `APP_BASE_URL`.

| Variable                       | App      | Required | Notes                                                                   |
| ------------------------------ | -------- | -------- | ----------------------------------------------------------------------- |
| `NEON_AUTH_BASE_URL`           | web, API | yes      | Neon Console → branch → Auth → Configuration → Auth URL                 |
| `NEON_AUTH_COOKIE_SECRET`      | web      | yes      | ≥ 32 characters; `openssl rand -base64 32`                              |
| `APP_BASE_URL`                 | web      | prod     | Public web origin; password-reset links. Must be a trusted domain       |
| `API_INTERNAL_URL`             | web      | no       | API origin from the Next.js server (default `NEXT_PUBLIC_API_URL`)      |
| `NEON_AUTH_JWKS_URL`           | API      | no       | Same origin as the Auth URL; default `<Auth URL>/.well-known/jwks.json` |
| `NEON_AUTH_AUDIENCE`           | API      | no       | Default: origin of the Auth URL                                         |
| `AUTH_MAX_TOKEN_AGE_SECONDS`   | API      | no       | Default `900`                                                           |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | API      | no       | Default `5`                                                             |
| `AUTH_STEP_UP_TTL_SECONDS`     | API      | no       | Default `600`, range 60–3600                                            |
| `AUTH_TRUSTED_ORIGIN`          | API      | no       | Origin sent on password re-verification; default first `CORS_ORIGINS`   |
| `DATABASE_URL` / `DIRECT_URL`  | API, CLI | yes / no | Neon pooled URL for the app; direct URL for Prisma migrations           |

Placeholders are in [`.env.example`](../.env.example). Never commit real values.

### Neon Console checklist (per environment)

1. Enable Neon Auth on the branch. Copy its Auth URL into `NEON_AUTH_BASE_URL`.
2. Enable email and password sign-in, and require email verification. EnvVault's UI uses
   **verification codes (OTP)**, not links.
3. Configure the email provider. Neon's shared sender is for development only.
4. Under trusted domains, add the web app's production origin (`APP_BASE_URL`). In
   production, also disallow `localhost`.
5. Apply EnvVault migrations with `pnpm db:migrate:deploy`, setting `DIRECT_URL` to the
   **same branch's** direct connection string. These migrations never touch `neon_auth`.

## 8. Tests

| Suite                                      | Command                 | Covers                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API unit tests                             | `pnpm test`             | Verifier: valid, expired, wrong issuer, audience or algorithm, bad signature, key rotation, JWKS outage. Password verifier: Origin header, user-ID mismatch, temporary session ended                                            |
| API integration (real Postgres, fake Neon) | `pnpm test:integration` | Missing, malformed, expired, forged and revoked tokens; banned users; default deny; cross-workspace access returns 404; missing permission returns 403; step-up required, failed and succeeded; logout revocation               |
| Database integration                       | `pnpm test:integration` | `auth_user_id` immutability and format, JIT provisioning races, revocation monotonicity, step-up lifetime CHECK                                                                                                                 |
| Web unit tests                             | `pnpm test`             | Server actions and SDK error codes, open-redirect protection, proxy matcher, env validation                                                                                                                                     |
| Web e2e (production build)                 | `pnpm test:e2e`         | Anonymous redirects on every protected route, forged cookies, auth pages, security headers                                                                                                                                      |
| Full-stack e2e                             | `pnpm test:e2e:auth`    | Registration with emailed OTP, wrong code, unverified sign-in, invalid credentials, safe `redirectTo`, HTTP-only cookies, logout and API revocation, sign-out everywhere, password reset, step-up deletion, cross-workspace 404 |

The full-stack suite replaces Neon Auth with `apps/web/e2e/support/neon-auth-standin.mjs`.
This is the real Better Auth library, configured like Neon: base path `/neondb/auth`,
`__Secure-neon-auth` cookies, EdDSA JWKS, 15-minute JWTs, email OTP and required
verification. It needs `E2E_DATABASE_URL`, a disposable database whose name contains
`test`, which is reset before each run. No Neon credentials are used in tests or CI.

## 9. Limitations and open items

- `@neondatabase/auth` is a **beta** SDK. Its error codes and endpoints may change; they
  are pinned and covered by tests.
- The stand-in mirrors Neon's documented behavior but is not Neon. Before production,
  verify these against a real Neon branch:
  - step-up password re-verification (managed Neon may apply different origin or rate
    limits to server-to-server sign-in);
  - the exact `iss` and `aud` values;
  - trusted-domain behavior.
- Neon's docs note that the SDK's `resetPasswordForEmail` is not fully supported, so
  EnvVault uses `requestPasswordReset` and `resetPassword`.
- **A password reset by email link does not revoke already-issued API tokens**, because
  EnvVault is not notified of the reset (a password _change_ in Settings does revoke them). They expire within 15 minutes. A Neon webhook could close this
  gap once one is available.
- Users who signed up only through OAuth have no password, so they cannot pass step-up
  and cannot perform sensitive actions. OAuth is not enabled yet.
- Rate limiting and JWKS caching are per API instance.
