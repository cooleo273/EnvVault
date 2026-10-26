# Roadmap

Where EnvVault stands and what comes next. "Completed" means implemented and
tested on a branch; nothing here is production ready (see
[security-hardening.md](security-hardening.md#10-remaining-risks-and-production-blockers)).

| Phase | Scope                                                                    | Status                                         |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| 1     | Authentication (Neon Auth), workspaces, members, invitations             | Completed                                      |
| 2     | Projects, custom environments, per environment access                    | Completed                                      |
| 3A    | Envelope encryption (AES-256-GCM, data keys per version)                 | Completed                                      |
| 3B    | Secrets: storage, versions, reveal, audit                                | Completed                                      |
| 3C    | .env import and export, history and rollback, bulk actions               | Completed                                      |
| 3D    | Environment comparison, inheritance, validation, snapshots               | Completed                                      |
| 3E    | Security hardening, key recovery, deployment readiness                   | Completed (PR #1 open, not merged)             |
| 4A    | Developer CLI: browser sign in, project linking, `run`, `pull`, `doctor` | Completed (local branch, not pushed)           |
| 4B    | Machine identities, service credentials, CI/CD authentication            | Implemented (local commit 64d5665, not pushed) |
| 4C    | Public API conventions, TypeScript and Python SDKs, developer docs       | Implemented (local commit 3c9cd95, not pushed) |
| 5A    | GitHub Actions OIDC federation and the EnvVault action                   | Implemented (local branch, not pushed)         |
| 5     | Further deployment integrations (hosting platforms, cloud stores)        | Planned                                        |
| 6     | Approvals and collaboration                                              | Planned                                        |
| 7     | Monitoring and rotation                                                  | Planned                                        |
| 8     | Enterprise features                                                      | Planned                                        |
| 9     | Deployment and release                                                   | Planned                                        |

## Phase 4B (implemented)

Implemented on `phase-4b/machine-identities`:

- Machine identities per project with lifecycle (disable, enable, retire),
  expiry, credential lifetime limits and activity.
- Service credentials (`evv_sk_`) stored as HMAC digests, shown once,
  rotated with overlap, revoked immediately.
- Token exchange for 15 minute machine access tokens (`evv_mt_`), narrowed
  by scope and environment, checked again on every request.
- Machine permissions limited to metadata, variable names and runtime
  values; grants checked against the granter's own access; protected
  environments only through direct grants.
- Machine routes separated from people's routes in both directions.
- CLI machine mode (`ENVVAULT_SERVICE_CREDENTIAL`, `envvault auth service`,
  `envvault run`), dashboard section, SDK, OpenAPI, audit events, CI
  examples.

Not in 4B:

- OIDC workload identity federation (planned, schema reserved).
- Deployment synchronization (Phase 5).

## Phase 4C (implemented)

Implemented on `phase-4c/api-sdk-ecosystem`:

- API conventions documented and enforced: one error envelope with a published code
  catalog, three pagination styles, idempotency keys, request ids, rate limit headers,
  deprecation headers (`Deprecation`, `Sunset`, `Link`) and a versioning policy.
- OpenAPI access metadata (callers, permissions, step up, deprecation) generated from
  the decorators the guards enforce, with a test that fails on drift.
- No new authentication: people, CLI tokens and machine tokens only; no personal API keys.
- TypeScript SDK: `EnvVaultMachineClient`, `@envvault/sdk/node`, cancellation,
  rate limit metadata and opt in retries for safe requests, pagination iterators,
  request ids on errors, package metadata, README and changelog.
- Python SDK (`packages/sdk-python`): sync and async clients, machine credential
  exchange and renewal, typed models and errors, `python -m envvault run`.
- `/developers/api` reference page (read only, no request console, no tokens).
- Examples for Node.js, Next.js, Python and CI, run against a local API in tests.
- Docs: [developer-guide.md](developer-guide.md), [api-reference.md](api-reference.md),
  [api-authentication.md](api-authentication.md), [api-versioning.md](api-versioning.md),
  [sdk-typescript.md](sdk-typescript.md), [sdk-python.md](sdk-python.md).

Not in 4C:

- Publishing either SDK (both are marked private until the licence and registries are
  decided; release steps are documented).
- Deployment platform integrations (Phase 5).

## Phase 5A (implemented)

Implemented on `phase-5a/github-actions-oidc`:

- GitHub Actions OIDC federation: tokens verified against GitHub's published
  keys from an explicit issuer allowlist, exchanged once for the Phase 4B
  machine access token (`POST /machine/oidc/token`).
- Trust bindings (`OIDC_FEDERATION` credentials plus `oidc_trust_policies`):
  repository and owner ids, workflow, reusable workflow, refs, GitHub
  environments, events, subject and EnvVault environments; strict rules for
  protected environments; pull_request_target never accepted.
- Binding management API, audit events and the project Integrations page with
  recent attempts and generated workflow examples.
- `packages/github-action`: bundled JavaScript action using the TypeScript SDK;
  masks values before the command runs and passes them only to it; explicit
  service credential fallback.
- TypeScript SDK OIDC mode and binding methods; six workflow examples; a local
  OIDC issuer for tests.
- Docs: [integrations/github-actions.md](integrations/github-actions.md),
  [integrations/github-oidc.md](integrations/github-oidc.md),
  [integrations/ci-security.md](integrations/ci-security.md).

Not in 5A:

- A GitHub App (writing GitHub secrets, repository discovery).
- Publishing the action.
- OIDC from other CI providers.

## Later phases

The outlines below are placeholders until each phase is specified.

- **5B, next.** To be specified (for example other CI providers or deployment
  platforms).
- **5, Further deployment integrations.** Delivering configuration to hosting and
  deployment platforms with machine identities.
- **6, Approvals and collaboration.** Enforcing the change request and
  approval model that protected environments already store.
- **7, Monitoring and rotation.** Secret rotation policies and operational
  monitoring.
- **8, Enterprise features.** Managed KMS, SSO and organisation controls.
- **9, Deployment and release.** Running EnvVault in production.

Known prerequisites for production regardless of phase are listed in
[security-hardening.md, section 10](security-hardening.md#10-remaining-risks-and-production-blockers).
