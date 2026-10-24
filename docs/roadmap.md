# Roadmap

Where EnvVault stands and what comes next. "Completed" means implemented and
tested on a branch; nothing here is production ready (see
[security-hardening.md](security-hardening.md#10-remaining-risks-and-production-blockers)).

| Phase | Scope                                                                    | Status                               |
| ----- | ------------------------------------------------------------------------ | ------------------------------------ |
| 1     | Authentication (Neon Auth), workspaces, members, invitations             | Completed                            |
| 2     | Projects, custom environments, per environment access                    | Completed                            |
| 3A    | Envelope encryption (AES-256-GCM, data keys per version)                 | Completed                            |
| 3B    | Secrets: storage, versions, reveal, audit                                | Completed                            |
| 3C    | .env import and export, history and rollback, bulk actions               | Completed                            |
| 3D    | Environment comparison, inheritance, validation, snapshots               | Completed                            |
| 3E    | Security hardening, key recovery, deployment readiness                   | Completed (PR #1 open, not merged)   |
| 4A    | Developer CLI: browser sign in, project linking, `run`, `pull`, `doctor` | Completed (local branch, not pushed) |
| 4B    | Machine identities, service credentials, CI/CD authentication            | In progress (this branch)            |
| 4C    | Public API and SDK                                                       | Planned                              |
| 5     | Deployment integrations                                                  | Planned                              |
| 6     | Approvals and collaboration                                              | Planned                              |
| 7     | Monitoring and rotation                                                  | Planned                              |
| 8     | Enterprise features                                                      | Planned                              |
| 9     | Deployment and release                                                   | Planned                              |

## Phase 4B

Done on this branch:

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

## Later phases

The outlines below are placeholders until each phase is specified.

- **4C, Public API and SDK.** A documented, versioned public surface and a
  published SDK and CLI.
- **5, Deployment integrations.** Delivering configuration to hosting and
  deployment platforms with machine identities.
- **6, Approvals and collaboration.** Enforcing the change request and
  approval model that protected environments already store.
- **7, Monitoring and rotation.** Secret rotation policies and operational
  monitoring.
- **8, Enterprise features.** Managed KMS, SSO and organisation controls.
- **9, Deployment and release.** Running EnvVault in production.

Known prerequisites for production regardless of phase are listed in
[security-hardening.md, section 10](security-hardening.md#10-remaining-risks-and-production-blockers).
