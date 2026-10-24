# Security hardening (Phase 3E)

This is the result of an internal security review of EnvVault after Phase 3D: what is
protected, where the boundaries are, what was found, what was fixed and what remains. It is
**not** an external penetration test, and passing the automated tests does not make the
application production ready. An independent assessment and verification on real
infrastructure are still required.

Related: [threat-model.md](threat-model.md) (encryption threats),
[key-management.md](key-management.md), [disaster-recovery.md](disaster-recovery.md),
[deployment.md](deployment.md), [operational-runbook.md](operational-runbook.md).

## 1. Protected assets

| Asset                               | Where it lives                                                                | Worst case if exposed                        |
| ----------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| Secret values                       | Encrypted in `secret_versions`; plaintext only in API memory during a request | Customer credentials leak                    |
| Key encryption keys (keyring)       | Keyring file on the API host; API memory                                      | Every value in every backup becomes readable |
| Recovery key                        | Offline, held by operators                                                    | Keyring backups become readable              |
| Integrity key                       | File on the API host                                                          | Audit seals can be forged                    |
| Session cookies, access tokens      | Browser (cookie), Next.js server, API memory                                  | Account takeover for the token lifetime      |
| Authorization state (roles, grants) | PostgreSQL                                                                    | Privilege escalation                         |
| Audit trail                         | `audit_events`, `audit_seals`                                                 | Activity can be hidden or invented           |
| Import files and exports            | Request bodies, browser downloads                                             | Bulk value leak                              |

## 2. Trust boundaries and attack surfaces

```
Browser ──(HTTPS, session cookie)──► Caddy ──► Next.js (server actions, BFF)
                                                   │ short lived JWT
                                                   ▼
                                     EnvVault API (not published) ──► PostgreSQL (Neon, TLS)
                                       │            │
                                       │            └──► Redis (rate limits, private network)
                                       └──► keyring and integrity key files (read only mount)
Operator ──(SSH)──► host ──► pnpm ops (rotation, backups, retention, audit verification)
```

Attack surfaces: the web origin (pages, server actions), the API routes (only reachable
through the web server in the reference deployment), the database (credentials held by the
API and the migration job), the key files on the host, operator tooling, CI and the
dependency tree.

## 3. Review coverage

| Area               | Checked                                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWASP Top 10       | Access control, cryptographic failures, injection (all SQL is parameterized; raw queries use tagged templates), insecure design, misconfiguration, vulnerable components, authentication, integrity, logging, request forgery                                                                                                          |
| OWASP API Top 10   | Object level authorization, authentication, property level authorization (strict schemas), resource consumption (limits and pagination), function level authorization, sensitive business flows, server side request forgery (no user supplied URLs are fetched), misconfiguration, inventory (OpenAPI route test), unsafe consumption |
| Secrets management | Plaintext in logs, errors, caches, browser storage and HTML; export and import abuse; history and rollback; key rotation, backup and loss                                                                                                                                                                                              |
| Sessions           | Token verification, expiry, revocation, step up, cross origin requests                                                                                                                                                                                                                                                                 |
| Operations         | Concurrency, retries, interrupted jobs, recovery, deployment configuration                                                                                                                                                                                                                                                             |

## 4. Findings

Severity is the reviewer's estimate of impact and likelihood for a small production
deployment. Each fixed finding has automated tests.

| #   | Severity            | Finding                                                                                                                                                                                                                   | Status                                                                                                                      |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| F1  | High                | Unhandled 5xx errors logged the raw Prisma error. Prisma messages can quote query arguments (ciphertext, wrapped keys, names, emails) and PostgreSQL details can quote row values.                                        | Fixed: minimal Prisma error format and a log serializer that keeps only codes and identifiers                               |
| F2  | High (availability) | All browser traffic reaches the API from the web server's address, so the per address limit (100 per minute) and the step up limit (5 per minute) were shared by every user. One user could lock everyone out of step up. | Fixed: per user limits after authentication; the address limit is a coarse bound                                            |
| F3  | High                | Rate limit counters were per process, so N instances allowed N times the limit. Imports, bulk changes, rollbacks, snapshot restores and permission changes had no limits.                                                 | Fixed: optional shared Redis store, fail closed policy for sensitive actions, limits for every listed action                |
| F4  | High                | Key lifecycle was incomplete: no database rewrap, no retirement with reference counts, no backups. Losing the keyring file lost every value.                                                                              | Fixed: operator tooling for rotation, resumable rewrap, verification, guarded retirement and encrypted keyring backups      |
| F5  | Medium              | Proposed values in `change_request_items` are envelopes without a key version, so retiring a key could orphan them.                                                                                                       | Fixed: retirement refuses while any exist; status reports them                                                              |
| F6  | Medium              | The audit trail relied on triggers that the database owner can disable.                                                                                                                                                   | Mitigated: HMAC seal chains with a key outside the database, verification and external head anchoring (limits in section 7) |
| F7  | Medium              | Time of check to time of use: access revoked while an import, bulk change, rollback or restore was being prepared still committed.                                                                                        | Fixed: access is evaluated again inside the write transaction                                                               |
| F8  | Medium              | A retried request (network failure, double submit) could apply a mutation twice or surface a confusing conflict.                                                                                                          | Fixed: `Idempotency-Key` with keyed fingerprints; the web server retries once with the same key                             |
| F9  | Medium              | No query timeout and a 5 second connect timeout, too short for a suspended Neon compute.                                                                                                                                  | Fixed: configurable connect (10 s) and query (30 s) timeouts                                                                |
| F10 | Medium              | Deleted variables, old versions, snapshots and audit events were kept forever with no controlled way to remove them.                                                                                                      | Fixed: retention policies with preview, confirmation, step up and safety exclusions                                         |
| F11 | Low                 | Refusals at the request guard were not audited (only refusals inside secret services).                                                                                                                                    | Fixed: one `authz.denied` event per user, route and minute                                                                  |
| F12 | Low                 | Readiness did not check that configured keys were usable.                                                                                                                                                                 | Fixed: encryption and rate limit store checks                                                                               |
| F13 | Low                 | `mysql2` and `deepmerge-ts` advisories in transitive dependencies.                                                                                                                                                        | Fixed by overrides; one reviewed exception remains (section 8)                                                              |
| F14 | Low                 | No secret scanning in CI.                                                                                                                                                                                                 | Fixed: repository scanner and gitleaks job                                                                                  |
| F15 | Deployment blocker  | The API refused every key provider in production, so it could not be deployed at all.                                                                                                                                     | Changed: an explicitly acknowledged self managed keyring is accepted in production (section 6)                              |

Snapshot capture and large imports were also slow (section 9); both were optimized.

## 5. Controls added or verified

**Logging and errors.** Request logs keep method, path without query, status and request id.
The error serializer reduces database errors to code, SQLSTATE, model, constraint and column;
crypto errors to their category; other errors to name, message and stack without attached
properties. Client errors carry fixed, safe messages. Prisma runs with `errorFormat: minimal`.

**Rate limits.** Address limit (default 1000 per minute, provisional; it is shared by every
user behind the web server and only stops floods) before authentication; per user limit
(default 600 per minute) after it; per user limits on sensitive actions after authorization,
so a 429 never reveals whether a resource exists:

| Action                                                                       | Default         | Also per                |
| ---------------------------------------------------------------------------- | --------------- | ----------------------- |
| Reveal a value (current or historical)                                       | 60 per minute   | variable, 20 per minute |
| Export, value comparison, readiness with values                              | 10 per minute   |                         |
| Import commit                                                                | 10 per minute   |                         |
| Bulk update, delete, restore                                                 | 20 per minute   |                         |
| Rollback                                                                     | 30 per minute   |                         |
| Snapshot restore                                                             | 5 per minute    |                         |
| Grants, revocations, member and role changes, invitations, retention changes | 30 per minute   |                         |
| Password confirmation (step up)                                              | 5 per 5 minutes |                         |

Every 429 carries `Retry-After`. The first refusal of a block is audited
(`secret.access_denied` with `reason: rate_limited`, or `security.rate_limited`).
**Failure policy** with `RATE_LIMIT_STORE=redis`: when Redis is unreachable, general limits
fall back to per instance counting and sensitive actions are refused with 503
`RATE_LIMIT_UNAVAILABLE`. Login attempts are rate limited by Neon Auth, which EnvVault does not
duplicate.

**Authorization at write time.** Import commits, bulk changes, rollbacks and snapshot
restores evaluate the caller's permissions again inside the transaction that writes, with the
same policy functions as the request guard. A revocation committed before that check stops the
write (403, audited with `reason: access_changed`); one committed after it orders after the
write.

**Idempotency.** Mutations accept `Idempotency-Key` (16 to 128 characters). The request
(method, route, query and body) is fingerprinted with an HMAC under the integrity key, never a
plain hash, because bodies can contain values. A retry replays the stored response
(`Idempotent-Replayed: true`); the same key with a different request gets 422; a key whose
first request is still running gets 409. Only successful responses are stored, for 24 hours,
and only on routes whose responses hold no values. Keys are scoped per user.

**Audit integrity.** See [section 7](#7-audit-integrity).

**Input handling.** JSON bodies are limited to 100 KB (imports to twice the configured import
size) and validated by schemas: unknown fields are dropped (retention inputs refuse them),
so a client cannot set server owned values such as owners, revisions or scopes. Malformed JSON
is refused without echoing it.

**Frontend.** Authenticated pages are dynamic and served with
`Cache-Control: private, no-cache, no-store` (checked by Playwright). Values are never part of
server rendered HTML (checked), never written to browser storage, and copied only on request.
Server actions authenticate through the session and the API authorizes every call; Next.js
compares the action request origin with the host. No third party scripts, no raw HTML
injection, generic error boundaries, `poweredByHeader: false`, server function argument
logging off.

## 6. Production keys

Development keyrings are refused in production. A **self managed** keyring
(`pnpm ops keys:init --usage self-managed`) is accepted in production only with
`ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED=true` and only from a file (not an environment
variable), and is refused outside production so production keys do not end up on developer
machines. This makes a small deployment possible; it does **not** make the keys as safe as a
managed KMS. See [key-management.md, section 7](key-management.md#7-self-managed-keys-in-production)
for what it does not protect against.

## 7. Audit integrity

A background pass (every 30 seconds, and `pnpm ops audit:seal`) seals committed audit events
in time order into one chain per workspace (plus `platform` for system events). Each seal is
`HMAC-SHA256(integrity key, chain || position || previous MAC || event)`, with the key in
`INTEGRITY_KEY_FILE`, outside the database. `pnpm ops audit:verify` recomputes every chain
and reports edited, removed, reordered and inserted sealed events, and prints each chain's
head (`chain:seq:mac`) for operators to record elsewhere; `--expect-head` compares against
those copies.

What it does not guarantee:

1. Events are only protected once sealed (up to about 35 seconds after commit).
2. Removing the newest seals together with their events is only detected against a head
   recorded outside the database.
3. Anyone who holds both database owner rights and the integrity key file can rewrite history
   and its seals.
4. Nothing here is a write once store. For stronger guarantees, ship heads (or events) to an
   external append only system.

Retention purges remove whole prefixes of a chain and leave a checkpoint (the last removed
MAC), so what remains still verifies.

## 8. Dependencies and configuration

`pnpm audit:deps` fails on high and critical advisories in production dependencies. There are
no audit exceptions: the `braces` exception (GHSA-vfj7-8cjw-p6xm) was removed on 2026-10-24 once
the audit stopped reporting it.

Updated on 2026-10-24: `next` 16.4.0 to 16.4.1 (critical remote code execution and high denial
of service advisories published 2026-10-14), `@next/eslint-plugin-next` to match, and `vitest`
4.1.11 to 4.1.12 (`@vitest/mocker`, GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp).

`sprintf-js` (moderate) comes from the test only Redis mock and has no patched release.
Fixed by overrides, each inside the same major version: `body-parser` 2.4.0 (Express request
bodies, GHSA-27r3-jxmh-p828), `multer` 2.5.0 (pinned exactly by `@nestjs/platform-express`,
GHSA-q7qp-rjg7-q26m), `undici` 8.12.2 (jsdom, tests only) and `fast-uri` 3.1.9 (Nest CLI, build
only), all published 2026-10-22 to 2026-10-24; `zod` 4.6.6 for the peer Neon Auth's `better-call`
had resolved to 4.5.4 (GHSA-mrhx-c7xc-m3w5, memory exhaustion), `mysql2` 3.24.5 (inside the Prisma CLI under
Neon Auth's adapter; never loaded) and `deepmerge-ts` 8.0.2 (GHSA-ggr8-5vv4-36mx, in Prisma's config loader). The
`deepmerge-ts` fix is a major version, so it was checked against every Prisma command used
here (generate, validate, format, migrate deploy and status, drift); Prisma 7.10.1 ships the
same version, and moving to that Prisma release once it is two weeks old should replace the
override. Secrets are kept out of Git (`.gitignore` covers environment files, keyrings,
recovery keys, backups and integrity keys) and out of images (`.dockerignore`);
`pnpm scan:secrets` and gitleaks run in CI.

## 9. Performance

Measured with `pnpm --filter @envvault/api bench` (synthetic data, local PostgreSQL 18, one
run of each sample; numbers are medians in milliseconds):

| Operation                           | Before | After |
| ----------------------------------- | ------ | ----- |
| Import commit, 500 variables        | 449    | 211   |
| Snapshot of 2000 variables          | 489    | 80    |
| Secret list, page of 50 out of 2000 | 9.6    | 8.9   |
| Environment detail                  | 6.7    | 6.7   |
| Compare 2000 with 2000 (metadata)   | 46     | 46    |
| Readiness on 2000 (metadata)        | 30     | 31    |
| Restore preview, 2000 variables     | 63     | 69    |
| Activity page                       | 7.4    | 7.3   |

The two improvements replace Prisma `createMany` (most of its time was spent per row in the
client) with multi row `INSERT` statements, and a snapshot capture with one
`INSERT ... SELECT` inside the same repeatable read transaction. Local numbers understate
network latency: every authorized request runs about five sequential queries (user, token
cutoff, membership, project, environment), which matters more against Neon and is not yet
batched. New indexes support key rotation queries, unsealed event scans and retention.

## 10. Remaining risks and production blockers

1. **Self managed keys on the application host.** Whoever controls the host or the API
   process can decrypt everything. A managed KMS provider is the main production blocker.
2. **No independent security assessment** has been done.
3. **The deployment was not built or run here** (no container runtime was available). Images,
   Compose file and Caddy configuration are reviewed configuration, not verified deployments.
4. **The Redis store was tested against an in process Redis emulator**, not a Redis server,
   and nothing has been tested with more than one API instance.
5. **Content Security Policy** still allows inline scripts until a nonce based policy is in
   place.
6. **Deletion is logical.** Retention removes rows; copies remain in Neon backups and history
   for Neon's retention period. There is no cryptographic erasure: the same key encryption key
   protects every workspace, so destroying keys cannot target one tenant's data.
7. **Audit integrity limits** in section 7.
8. **Revocation during a request** is checked again before writes, not before reads: a reveal
   that passed authorization completes.
9. The production CSP's `upgrade-insecure-requests` breaks prefetches on the plain http
   Playwright server (`ERR_SSL_PROTOCOL_ERROR`); the landing page test ignores that one error
   instead of weakening the policy.
10. Clipboard contents and downloaded exports are outside EnvVault's control.

## 11. Phase 4A: developer CLI

New attack surfaces: the public device authorization endpoints, CLI tokens on developer
machines, and plaintext values in child process environments and `.env` files.

| Risk                                     | Control                                                                                                                                                                                                                   | Test                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Phishing a CLI approval                  | User code shown in terminal and browser, host and platform shown with a "not verified" warning, approval needs a fresh password confirmation, 10 minute expiry, per user approval limit                                   | `cli-auth.int-spec.ts`                                     |
| Guessing or polling device codes         | 32 random bytes, stored hashed, `SLOW_DOWN`, single use, sensitive rate limit                                                                                                                                             | `cli-auth.int-spec.ts`                                     |
| Stolen CLI token                         | 1 hour access token; route allow list (`CLI_TOKEN_NOT_ALLOWED` elsewhere); refresh rotation with reuse detection that revokes the session; revocation in Security settings, on sign out everywhere and on password change | `cli-auth.int-spec.ts`, `cli-process.int-spec.ts`          |
| Tokens at rest                           | Hashes only in the database; OS credential store on the client; file store only on explicit opt in, mode `0600`, refused when readable by others                                                                          | `credentials.test.ts`, `cli-process.int-spec.ts`           |
| Bulk retrieval through the runtime route | Separate `secret:runtime` permission, no inheritance into protected environments, step up, per user and per environment limits, 2000 values and 1 MiB ceilings, audit before return, `no-store`                           | `cli-auth.int-spec.ts`                                     |
| Values leaking from the CLI              | No shell, values only in the child environment, counts but never values printed, error messages reduced to API codes and categories, no values in arguments                                                               | `run.test.ts`, `errors.test.ts`, `cli-process.int-spec.ts` |
| `.env` files in the wrong place          | `pull` needs `secret:export`, refuses published and shipped directories, paths outside the project and world writable directories, writes `0600` atomically, adds the file to `.gitignore`, asks before replacing         | `pull.test.ts`, `cli-process.int-spec.ts`                  |
| Talking to the wrong API                 | `https` required except on loopback; protocol version check through `GET /api/v1/meta` before sign in                                                                                                                     | `config.test.ts`, `client.test.ts`                         |

Remaining risks:

1. A child process, the same operating system user and administrators can read values
   injected by `envvault run`; Node.js cannot erase strings from memory.
2. A compromised developer machine can use the CLI session until it expires or is revoked.
3. The reference deployment does not publish the API (section 2); CLI use against it needs
   an HTTPS route to the API, which has not been designed or reviewed yet.
4. Device and session tables are cleaned only by expiry checks; no purge job removes old
   rows yet.
5. Windows behaviour (credential manager, signals, file ACLs) is covered by unit tests only.

## 12. Phase 4B: machine identities

New attack surfaces: long lived service credentials in CI systems, the public token exchange,
and grants that give automation access to environments.

| Risk                                                     | Control                                                                                                                                                                                                                 | Test                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Credential theft from the database                       | Only an HMAC-SHA256 digest under the integrity key is stored, bound to the lookup id; constant time verification; digest immutable                                                                                      | `machine-identities.int-spec.ts`, `access.test.ts` (database)                  |
| Forging credentials with database write access           | The digest needs the integrity key, which is not in the database                                                                                                                                                        | design (`machine-tokens.ts`)                                                   |
| Credential leaks in logs and output                      | Shown once; `no-store`; never retried automatically; never in audit metadata; the CLI has no credential argument and strips it from child processes; scanners know the `evv_sk_` and `evv_mt_` formats                  | `machine-identities.int-spec.ts`, `cli-machine.int-spec.ts`, `machine.test.ts` |
| Long lived bearer credential reuse                       | Accepted only by the exchange; access tokens last 15 minutes and are checked again on every request; revocation, disabling and expiry stop the next request                                                             | `machine-identities.int-spec.ts`                                               |
| Privilege escalation through machines                    | Machines hold only metadata and runtime permissions; grants need the granter's own permissions on that environment, `environment:protect` for protected ones and step up; no inheritance from creators or project roles | `machine-identities.int-spec.ts`, `access.test.ts` (shared)                    |
| Cross tenant use                                         | Identity, credential, token and grant are tied by composite foreign keys to one workspace and project; environment ids from elsewhere answer 404                                                                        | `machine-identities.int-spec.ts`, `access.test.ts` (database)                  |
| Machine tokens on people's routes and the reverse        | The global authentication guard separates them (`MACHINE_TOKEN_NOT_ALLOWED`, `MACHINE_TOKEN_REQUIRED`, `SERVICE_CREDENTIAL_NOT_ACCEPTED`)                                                                               | `machine-identities.int-spec.ts`                                               |
| Guessing and flooding                                    | 95 bit lookup ids and 256 bit secrets; exchanges limited per credential and per address; runtime loads per identity and environment; refusals audited once per minute and reason                                        | `machine-identities.int-spec.ts`                                               |
| Issuing a credential that reaches what the issuer cannot | Issuing and rotating need the issuer's own permissions on every environment the credential reaches (`GRANT_EXCEEDS_AUTHORITY`, audited as `service_credential.refused`); found in the Phase 4B review and fixed         | `machine-identities.int-spec.ts`                                               |
| Concurrent rotation                                      | Unique `rotated_from_id`: a credential is replaced at most once                                                                                                                                                         | `machine-identities.int-spec.ts`                                               |

Remaining risks:

1. Access tokens are bearer tokens: one stolen from a running job works until it expires (at most
   15 minutes) or is revoked. There is no request signing or token binding.
2. A credential stolen from a CI secret store works until it is revoked or expires; EnvVault cannot
   detect use from an unexpected place beyond the activity log.
3. No OIDC workload identity federation yet, so CI systems must store a credential.
4. Without `INTEGRITY_KEY_FILE` (development) credentials stop working at restart; removing an old
   integrity key invalidates every credential it signed.
5. Expired access token rows are not purged yet.
6. Next.js was upgraded from 16.4.0 to 16.4.1 for the critical and high advisories of
   2026-10-14 (see section 8).
