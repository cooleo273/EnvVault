# API authentication

How callers authenticate to the EnvVault API (`/api/v1`), which routes each
kind of caller may use, and what happens when a token is refused. The API has
exactly three kinds of authenticated caller and no other API key mechanism.

- People: [authentication.md](authentication.md)
- CLI: [cli-authentication.md](cli-authentication.md)
- Machine identities: [machine-identities.md](machine-identities.md),
  [service-credentials.md](service-credentials.md),
  [ci-authentication.md](ci-authentication.md)

## 1. Callers

| Caller           | Token                                            | Lifetime                                            | Stored by EnvVault | Obtained from                                       |
| ---------------- | ------------------------------------------------ | --------------------------------------------------- | ------------------ | --------------------------------------------------- |
| Person           | Neon Auth JWT (EdDSA)                            | Minutes, minted per request by the web app's server | Not stored         | Signing in to the web app                           |
| CLI              | `evv_at_` access token (`evv_rt_` refresh token) | 1 hour (refresh 30 days, session at most 90 days)   | SHA-256 hash       | Browser approved device flow                        |
| Machine identity | `evv_mt_` access token                           | At most 15 minutes                                  | SHA-256 hash       | `POST /machine/token` or `POST /machine/oidc/token` |
| Exchange only    | `evv_sk_` service credential                     | 1 to 365 days                                       | HMAC-SHA256 digest | Issued once in the dashboard or API                 |
| Exchange only    | GitHub Actions OIDC token (JWT)                  | Minutes, issued by GitHub per job                   | Not stored         | The job, with `id-token: write`                     |

Every token is sent as `Authorization: Bearer <token>`. Health, readiness,
`GET /meta`, `GET /openapi.json` and the CLI device start and polling routes
are public.

There is no personal API key. A person who needs API access from a script
signs in with the CLI (its tokens reach only the routes the CLI needs), and
automation uses a machine identity scoped to one project.

## 2. Which routes each caller reaches

The authentication guard decides by token prefix before any authorization
runs:

| Token               | Route kind                 | Result                                                   |
| ------------------- | -------------------------- | -------------------------------------------------------- |
| `evv_sk_`           | any route                  | `401 SERVICE_CREDENTIAL_NOT_ACCEPTED`: exchange it first |
| `evv_mt_`           | `/machine` routes          | Authenticated as the machine identity                    |
| `evv_mt_`           | any other route            | `403 MACHINE_TOKEN_NOT_ALLOWED`                          |
| person or CLI token | `/machine` routes          | `401 MACHINE_TOKEN_REQUIRED`                             |
| `evv_at_`           | routes allowed for the CLI | Authenticated as the person who approved the session     |
| `evv_at_`           | any other route            | `403 CLI_TOKEN_NOT_ALLOWED`                              |
| Neon Auth JWT       | people's routes            | Verified against the Neon Auth JWKS                      |

So a machine token never reaches workspace, member, role, identity or
credential administration, and a CLI token never reaches administration
either. The OpenAPI document lists the callers of each operation in
`x-envvault-callers`; a test compares it with the decorators the guard reads.

## 3. Authorization after authentication

Authentication only says who is calling. Every route then checks, on every
request:

- **People and the CLI:** an active membership in the workspace in the URL
  whose role grants the route's permission, then project and environment
  access. Protected environments need a direct grant. Sensitive actions need
  a recent password confirmation (step up), which the CLI cannot provide.
- **Machine identities:** the identity is active and not expired, the
  credential that minted the token is active, the token carries the scope
  (`environment:read`, `secret:list`, `secret:runtime`) and the environment,
  and the identity holds a grant on that environment. Protected environments
  are reachable only through a direct grant. Removing a grant, revoking a
  credential or disabling the identity takes effect on the next request.

Ids from another workspace or project answer `404`, never `403`.

## 4. Machine token exchange

```bash
curl -X POST "$ENVVAULT_API_URL/api/v1/machine/token" \
  -H "Authorization: Bearer $ENVVAULT_SERVICE_CREDENTIAL" \
  -H "Content-Type: application/json" \
  -d '{"scopes":["secret:runtime"]}'
```

The response holds `accessToken` (`evv_mt_`), `expiresIn`, `expiresAt`, the
`scopes` and `environmentIds` it covers, and the identity and credential it
belongs to. The body may narrow
`scopes` and `environmentIds`; it can never widen them. End the token early
with `POST /machine/token/revoke`.

Both SDKs do this for you: they exchange on first use, renew a minute before
expiry, exchange again once after `TOKEN_EXPIRED`, `TOKEN_REVOKED` or
`TOKEN_INVALID`, and revoke the last token when the client is closed.

### GitHub Actions OIDC

`POST /machine/oidc/token` takes the job's GitHub OIDC token as the bearer
and returns the same access token, for the identity of the one trust binding
whose conditions the token meets. The token is verified against the
allowlisted issuer's keys and accepted once. See
[integrations/github-oidc.md](integrations/github-oidc.md).

## 5. Refusals

| Status | Code                                                             | Meaning                                                 | What to do                             |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| 401    | `UNAUTHENTICATED`                                                | No bearer token                                         | Send one                               |
| 401    | `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`                | Token unusable                                          | Sign in again or exchange again        |
| 401    | `INVALID_CREDENTIAL`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED` | Service credential unusable                             | Issue a new credential                 |
| 401    | `IDENTITY_DISABLED`, `IDENTITY_EXPIRED`                          | Machine identity disabled, retired or expired           | Ask a project admin                    |
| 403    | `FORBIDDEN`, `SCOPE_NOT_GRANTED`                                 | Authenticated but not allowed                           | Ask for the permission, scope or grant |
| 403    | `STEP_UP_REQUIRED`                                               | Sensitive action without a recent password confirmation | Confirm the password in the web app    |
| 403    | `MACHINE_TOKEN_NOT_ALLOWED`, `CLI_TOKEN_NOT_ALLOWED`             | Wrong kind of caller for this route                     | Use the web app                        |
| 429    | `TOO_MANY_REQUESTS`                                              | Rate limited                                            | Wait `Retry-After` seconds             |

Failed exchanges and refused machine requests are audited without the token.

## 6. Handling tokens safely

- Keep service credentials in your CI provider's or platform's secret store,
  or in a file readable only by its owner (`ENVVAULT_SERVICE_CREDENTIAL_FILE`).
  Never in source code, images, logs or browser code.
- Never put any EnvVault token in a URL, a query string or browser storage.
  The web app keeps people's tokens server side.
- Use one machine identity per workload and environment set, narrow
  credential scopes, and the shortest credential lifetime that is practical.
- Rotate with overlap (`POST .../credentials/{id}/rotate`), and revoke on any
  suspicion of exposure.
- Values in a process's environment are readable by the same OS user and by
  administrators of the host; environment variables are not an isolation
  boundary.
