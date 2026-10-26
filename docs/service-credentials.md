# Service credentials

How a machine identity proves who it is, and how those credentials are
issued, used, rotated and revoked. See
[machine-identities.md](machine-identities.md) for identities and grants.

## 1. Two kinds of secret

|                      | Format                                                  | Lifetime                                           | Used at                           | Stored by EnvVault |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------- | --------------------------------- | ------------------ |
| Service credential   | `evv_sk_<16 character lookup id>_<43 character secret>` | 1 to 365 days (default 30, capped by the identity) | `POST /api/v1/machine/token` only | HMAC-SHA256 digest |
| Machine access token | `evv_mt_<43 characters>`                                | at most 15 minutes                                 | every other `/machine` route      | SHA-256 hash       |

The prefixes make leaked tokens recognisable: `pnpm scan:secrets` and the
repository's gitleaks rules (`.gitleaks.toml`) flag both formats, as well as
the CLI's `evv_at_` and `evv_rt_` tokens.

The credential is long lived and should travel as little as possible, so it
is accepted at one endpoint only; sent anywhere else it is refused with
`SERVICE_CREDENTIAL_NOT_ACCEPTED`. Everything else uses short lived access
tokens.

## 2. Issuing

`POST …/machine-identities/{id}/credentials` with a name, one or more scopes
(`environment:read`, `secret:list`, `secret:runtime`) and `expiresInDays`.
It needs `service_identity:manage` and a recent password confirmation, and
is limited to 20 issues or rotations per person per five minutes. An identity
has at most 10 working credentials.

Whoever receives a credential can use everything it reaches, so the issuer
must hold, on every environment granted to the identity, the permissions the
credential's scopes unlock there. A project admin without Production access
therefore cannot issue (or rotate) a runtime credential for an identity that
someone else granted Production; a credential narrowed to scopes they do
hold is fine. Refusals answer `GRANT_EXCEEDS_AUTHORITY` and are audited as
`service_credential.refused`.

The response contains the token **once**. It is not stored, cannot be shown
again, and is not cached (`no-store`; the route is excluded from idempotent
replay, and the web app and SDK never retry it automatically, since a
repeat would issue a second credential).

### How it is stored

- 32 random bytes from the operating system's generator form the secret; 16
  random characters form the lookup id.
- EnvVault stores the lookup id, and `HMAC-SHA256(lookup id "." secret)`
  under a subkey of the integrity key (`INTEGRITY_KEY_FILE`, HKDF purpose
  `service-credential`), with the key's id. A database reader cannot use the
  digest, and a database writer cannot mint a working credential without the
  key.
- Verification recomputes the HMAC and compares in constant time.
- Digest, lookup id, scopes and rotation link are immutable (database
  trigger).
- Rotating the integrity key file keeps older keys for verification, so
  existing credentials keep working; remove an old key only after every
  credential it signed has expired.

Without `INTEGRITY_KEY_FILE` (development only; production refuses to start
without it) the key exists only in the API process: credentials issued then
stop working at the next restart. The dashboard warns about this.

## 3. Exchanging

```http
POST /api/v1/machine/token
Authorization: Bearer evv_sk_…
Content-Type: application/json

{ "scopes": ["secret:runtime", "environment:read"], "environmentIds": ["…"] }
```

Both fields are optional and can only narrow: asking for a scope the
credential lacks, or an environment outside the identity's project, fails
with `SCOPE_NOT_GRANTED`. The response holds the access token, its expiry
(15 minutes, or earlier if the credential or identity ends sooner), the
granted scopes and environments, and the identity.

Refusals:

| Code                 | Status | Meaning                                                 |
| -------------------- | ------ | ------------------------------------------------------- |
| `INVALID_CREDENTIAL` | 401    | Malformed, unknown, or wrong secret (no further detail) |
| `CREDENTIAL_REVOKED` | 401    | Revoked, or the identity was retired                    |
| `CREDENTIAL_EXPIRED` | 401    | Past its expiry                                         |
| `IDENTITY_DISABLED`  | 401    | Identity disabled                                       |
| `IDENTITY_EXPIRED`   | 401    | Identity past its expiry                                |
| `SCOPE_NOT_GRANTED`  | 403    | Narrowing asked for more than the credential has        |
| `TOO_MANY_REQUESTS`  | 429    | Exchange limit for this credential                      |

Precise reasons are given only after the secret has been verified, so they
tell nothing to someone without the credential.

## 4. Using an access token

Send `Authorization: Bearer evv_mt_…` to the `/machine` routes. Each
request reads the token, its credential and its identity again, so revoking or
disabling anything stops the next request (not requests already running).
Machine tokens on any other route get `403 MACHINE_TOKEN_NOT_ALLOWED`;
people's tokens on `/machine` routes get `401 MACHINE_TOKEN_REQUIRED`.
`POST /machine/token/revoke` ends a token early; the CLI does this after
every command.

**Replay.** Tokens are bearer tokens: anyone holding one can use it until it
expires or is revoked. EnvVault limits this with the 15 minute lifetime,
immediate revocation, credentials that never leave the exchange endpoint,
HTTPS only clients, and audit of every use. Request signing or binding
tokens to a client key is not implemented.

## 5. Rotation

`POST …/credentials/{cid}/rotate` with `overlapHours` (0 to 168, default 24)
and optionally `expiresInDays`. It issues a replacement with the same name
and scopes and shortens the old credential to the overlap window (0 revokes
it at once). Deployments switch to the new token during the overlap without
downtime.

A credential is rotated at most once: the unique `rotated_from_id` makes a
concurrent second rotation fail with `CREDENTIAL_ALREADY_ROTATED`, and only
working credentials can be rotated. Needs a password confirmation.

## 6. Revocation and expiry

- `POST …/credentials/{cid}/revoke` (optional `reason`, password
  confirmation): the credential and every access token from it stop at
  once.
- Disabling an identity ends all its tokens; retiring it revokes all its
  credentials.
- Expired credentials stay listed (status `EXPIRED`) for history.
- Access tokens cannot outlive their credential or identity.

## 7. Rate limits

| Setting                               |        Default | Counts                                     |
| ------------------------------------- | -------------: | ------------------------------------------ |
| `MACHINE_TOKEN_RATE_LIMIT`            |  30 per minute | Exchanges per credential                   |
| `RATE_LIMIT_SENSITIVE_MAX`            |  20 per minute | Exchanges per client address               |
| `MACHINE_RUNTIME_RATE_LIMIT`          | 120 per minute | Runtime loads per identity                 |
| `MACHINE_RUNTIME_RESOURCE_RATE_LIMIT` |  60 per minute | Runtime loads per identity and environment |
| `RATE_LIMIT_USER_MAX`                 | 600 per minute | All machine requests per identity          |

Runtime loads also obey `RUNTIME_MAX_BYTES` and the 2000 value ceiling.

## 8. Handling credentials

- Keep them in the CI system's secret store, a secrets manager, or a file
  only the job's user can read. Never in the repository, `.envvault.json`,
  Docker build arguments, image layers or chat.
- One identity per pipeline or server, one credential per place it is
  deployed, the shortest lifetime that is practical.
- If one leaks: revoke it, check the identity's activity for
  `machine.authenticated` events you do not recognise, and issue a new one.
