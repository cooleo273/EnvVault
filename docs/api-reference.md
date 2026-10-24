# API reference

The EnvVault REST API: conventions every route follows, and where to find the
details of each one.

- **Interactive reference:** `/developers/api` in the web app, generated from
  the live OpenAPI document. Read only: it never asks for or stores a token.
- **OpenAPI 3.0 document:** `GET /api/v1/openapi.json` (public, no data).
  Schemas come from the Zod validators the API runs; who may call each route,
  its permission and step up come from the decorators the guards enforce, and a
  test fails if either drifts.
- **Related:** [api-authentication.md](api-authentication.md),
  [api-versioning.md](api-versioning.md), [sdk-typescript.md](sdk-typescript.md),
  [sdk-python.md](sdk-python.md), [developer-guide.md](developer-guide.md).

## 1. Base URL and versions

All routes live under `/api/v1` on the API origin. `GET /api/v1/meta` returns
the API version and the protocol version (`1`); clients compare it before
sending credentials (`checkCompatibility` in both SDKs). See
[api-versioning.md](api-versioning.md).

## 2. Authentication

| Caller           | Token                                                        | Where it works                                      |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Person           | Short lived Neon Auth JWT minted by the web app's server     | Every route not marked otherwise                    |
| CLI              | `evv_at_` access token from the browser approved device flow | Routes whose `x-envvault-callers` includes `cli`    |
| Machine identity | `evv_mt_` access token from `POST /machine/token`            | `/machine` routes only                              |
| Exchange         | `evv_sk_` service credential                                 | `POST /machine/token` only                          |
| Anyone           | none                                                         | Health, meta, OpenAPI, CLI device start and polling |

Each operation in the OpenAPI document lists its `security` schemes and
`x-envvault-callers`. Details: [api-authentication.md](api-authentication.md).

## 3. Scoping and ids

- Resources are addressed through their parents:
  `/workspaces/{workspaceId}/projects/{projectId}/environments/{environmentId}/...`.
  The guard loads each level inside the previous one, so an id from another
  workspace or project answers `404`.
- Ids are UUIDs. Malformed ids also answer `404`.
- Machine identities are bound to one project; their routes take only the
  environment id, and the identity's grants decide the rest.

## 4. Requests

- JSON bodies (`Content-Type: application/json`), limited in size per route.
- Unknown fields are rejected on strict inputs.
- Timestamps are ISO 8601 in UTC.

## 5. Pagination, filtering and sorting

Three styles, each documented per route:

| Style  | Query                                                    | Response                                         | Used by                                      |
| ------ | -------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Pages  | `page` (from 1), `pageSize` (route maximum, usually 100) | `items`, `page`, `pageSize`, `total`             | projects, environments, variables, snapshots |
| Cursor | `cursor`, `limit`                                        | `items`, `nextCursor` (null at the end)          | project and machine identity activity        |
| Before | `before`, `limit`                                        | `items`, `total`, `nextBefore` (null at the end) | version history                              |

Lists accept `q` (case insensitive search) and `status`
(`active`, `archived`, `all` where applicable); projects and variables also
take `sort` and `order` (`asc`, `desc`). Both SDKs iterate every style.

## 6. Errors

Every non 2xx response has the same envelope:

```json
{
  "error": {
    "statusCode": 404,
    "code": "NOT_FOUND",
    "message": "Not found",
    "requestId": "8a0f1c2e-5b44-4d7a-9a51-0c0f6f4e2d11",
    "issues": [{ "path": "name", "message": "Enter a name" }]
  }
}
```

- Branch on `code`, never on `message`.
- `issues` lists field problems (paths and messages, never submitted values).
- `requestId` is also in the `X-Request-Id` header; quote it when reporting a
  problem.
- `400 BAD_REQUEST` with `issues`: the body or query does not match the schema.
  `422 VALIDATION_FAILED`: it is well formed but not acceptable (for example
  an expiry in the past).
- `404 NOT_FOUND` covers both missing resources and resources outside your
  access, so ids cannot be probed.
- `409` with a specific code: archived resources, name conflicts, stale
  revisions.
- 5xx responses never contain internal details.

### Error codes

Published in the OpenAPI document as `x-envvault-error-codes`.

| Area         | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| general      | `BAD_REQUEST`, `CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL_SERVER_ERROR`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `RATE_LIMIT_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `UNPROCESSABLE_ENTITY`, `VALIDATION_FAILED`                                                                                                                                                                     |
| auth         | `ACCOUNT_DISABLED`, `AUTH_UNAVAILABLE`, `EMAIL_NOT_VERIFIED`, `FORBIDDEN`, `STEP_UP_FAILED`, `STEP_UP_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REVOKED`, `UNAUTHENTICATED`                                                                                                                                                                                                                                                                       |
| workspaces   | `ALREADY_MEMBER`, `CANNOT_CHANGE_OWN_ROLE`, `INVITATION_EMAIL_MISMATCH`, `INVITATION_INVALID`, `INVITATION_PENDING`, `LAST_OWNER`, `OWNER_REQUIRED`, `SLUG_TAKEN`, `WORKSPACE_ARCHIVED`, `WORKSPACE_NOT_ARCHIVED`                                                                                                                                                                                                                                           |
| projects     | `ALREADY_PROJECT_MEMBER`, `CANNOT_CHANGE_OWN_ACCESS`, `ENVIRONMENT_ARCHIVED`, `ENVIRONMENT_NAME_TAKEN`, `ENVIRONMENT_NOT_ARCHIVED`, `ENVIRONMENT_SLUG_TAKEN`, `NOT_PROJECT_MEMBER`, `NOT_WORKSPACE_MEMBER`, `PROJECT_ARCHIVED`, `PROJECT_NOT_ARCHIVED`, `PROJECT_SLUG_TAKEN`, `PROTECTION_REQUIRED`, `TEMPLATE_NAME_TAKEN`, `TEMPLATE_NOT_FOUND`                                                                                                            |
| secrets      | `ENCRYPTION_UNAVAILABLE`, `SECRET_CONFLICT`, `SECRET_INTEGRITY_ERROR`, `SECRET_KEY_TAKEN`, `SECRET_NOT_DELETED`, `SECRET_VALUE_NOT_SET`, `SECRET_VALUE_REQUIRED`                                                                                                                                                                                                                                                                                            |
| transfers    | `SECRET_BULK_TOO_LARGE`, `SECRET_IMPORT_REJECTED`, `SECRET_IMPORT_TOO_LARGE`, `SECRET_ROLLBACK_NOOP`, `SECRET_ROLLBACK_TYPE_MISMATCH`                                                                                                                                                                                                                                                                                                                       |
| intelligence | `ENVIRONMENT_TOO_LARGE`, `INHERITANCE_INVALID`, `SNAPSHOT_RESTORE_BLOCKED`, `SNAPSHOT_STALE`                                                                                                                                                                                                                                                                                                                                                                |
| retention    | `RETENTION_POLICY_EMPTY`, `RETENTION_RUN_ACTIVE`                                                                                                                                                                                                                                                                                                                                                                                                            |
| cli          | `ACCESS_DENIED`, `AUTHORIZATION_PENDING`, `CLI_TOKEN_NOT_ALLOWED`, `EXPIRED_TOKEN`, `INVALID_GRANT`, `RUNTIME_TOO_LARGE`, `SLOW_DOWN`                                                                                                                                                                                                                                                                                                                       |
| machine      | `CREDENTIALS_UNAVAILABLE`, `CREDENTIAL_ALREADY_ROTATED`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_LIMIT_REACHED`, `CREDENTIAL_REVOKED`, `GRANT_EXCEEDS_AUTHORITY`, `GRANT_EXISTS`, `IDENTITY_DISABLED`, `IDENTITY_EXPIRED`, `IDENTITY_LIMIT_REACHED`, `IDENTITY_NAME_TAKEN`, `IDENTITY_RETIRED`, `INVALID_CREDENTIAL`, `MACHINE_TOKEN_NOT_ALLOWED`, `MACHINE_TOKEN_REQUIRED`, `ROLE_NOT_MACHINE_GRANTABLE`, `SCOPE_NOT_GRANTED`, `SERVICE_CREDENTIAL_NOT_ACCEPTED` |

## 7. Rate limits

Every route can answer `429 TOO_MANY_REQUESTS` with `Retry-After` (seconds).
Limits apply per client address, per person or machine identity, and per
sensitive action (reveals, exports, runtime loads, token exchanges, password
confirmations). When the shared limit store is unavailable, sensitive actions
answer `503 RATE_LIMIT_UNAVAILABLE` rather than running unlimited. The SDKs
expose `retryAfterSeconds` / `retry_after` and only wait and retry when asked
(`rateLimitRetries` / `rate_limit_retries`), and then only for safe requests.

## 8. Idempotency

These mutations accept `Idempotency-Key` (16 to 128 letters, digits, `_` or
`-`): variable create, update, delete, restore and rollback; import and bulk
changes; snapshot create and restore; retention runs. Any other key format
answers `400 IDEMPOTENCY_KEY_INVALID`. A repeat with the same key and request returns the stored
response (`Idempotent-Replayed: true`); a different request with the same key
answers `422 IDEMPOTENCY_KEY_REUSED`; one still running answers
`409 IDEMPOTENCY_IN_PROGRESS`. Responses holding values (reveal, export,
runtime) and credential issuing are never stored, so they do not take keys and
must not be retried blindly. In the TypeScript SDK use
`client.withIdempotencyKey(key)`.

## 9. Caching

Responses that contain values or credentials (reveal, export, runtime,
credential issue and rotation, CLI and machine tokens) carry
`Cache-Control: no-store`. Do not cache them anywhere.

## 10. Response headers

| Header                          | Meaning                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `X-Request-Id`                  | Request id (send your own to correlate: 8 to 128 letters, digits, `.`, `_` or `-`) |
| `Retry-After`                   | Seconds to wait (429, some 503)                                                    |
| `Idempotent-Replayed`           | `true` when an idempotent response was replayed                                    |
| `Deprecation`, `Sunset`, `Link` | On deprecated routes ([api-versioning.md](api-versioning.md))                      |

## 11. Example: runtime values for a machine identity

```http
POST /api/v1/machine/token
Authorization: Bearer evv_sk_…
Content-Type: application/json

{}
```

```json
{
  "accessToken": "evv_mt_…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "expiresAt": "2026-10-24T12:15:00.000Z",
  "scopes": ["environment:read", "secret:list", "secret:runtime"],
  "environmentIds": [],
  "identity": { "id": "…", "name": "GitHub Actions QA", "workspaceId": "…", "projectId": "…" },
  "credential": { "id": "…", "name": "ci", "expiresAt": "2026-11-23T12:00:00.000Z" }
}
```

```http
POST /api/v1/machine/environments/0190f1c2-0000-7000-8000-000000000001/runtime
Authorization: Bearer evv_mt_…
Content-Type: application/json

{ "includeInherited": true }
```

```json
{
  "environmentId": "0190f1c2-0000-7000-8000-000000000001",
  "values": [{ "key": "API_URL", "value": "https://api.example.test", "source": "local" }],
  "missingRequired": [],
  "withheldInherited": 0,
  "issuedAt": "2026-10-24T12:00:05.000Z"
}
```

Values are synthetic; tokens are elided.
