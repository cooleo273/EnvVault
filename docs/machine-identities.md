# Machine identities

A machine identity is how a CI pipeline, deployment server or background job
reaches EnvVault without a person's credentials. Examples: "GitHub Actions
QA", "Production Deployment Worker", "Staging Build Server".

Related: [service-credentials.md](service-credentials.md) (credentials,
token exchange, rotation), [ci-authentication.md](ci-authentication.md) (CI
examples), [authorization.md](authorization.md#10-phase-4b-machine-identities).

## 1. Model

| Field                                   | Meaning                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `id`, `name`, `description`             | Stable id; name unique per workspace among live identities                            |
| workspace, project                      | Owned by one workspace and confined to one project (both immutable)                   |
| `status`                                | `ACTIVE`, `DISABLED` (reversible), `EXPIRED` (past `expiresAt`), `RETIRED` (for good) |
| `expiresAt`                             | Optional end of the identity; afterwards no credential of it works                    |
| `credentialMaxLifetimeDays`             | Longest lifetime a new credential may have (1 to 365, default 90)                     |
| created by, created at                  | The person who created it (for history only, see below)                               |
| `lastAuthenticatedAt`                   | Last successful credential exchange                                                   |
| `lastUsedAt`                            | Last request with one of its access tokens (written at most once a minute)            |
| disabled at, by, reason; retired at, by | Revocation metadata                                                                   |

Stored in `service_identities` (the Phase 1 table, extended by migration
`20261026090000_machine_identities`). A project holds at most 100 live
identities.

**Independent of people.** An identity is not a user and has no membership.
It never inherits the permissions of the person who created it: when that
person loses access, or leaves the workspace, the identity is unaffected, and
an identity created by a workspace owner has no more access than one created
by anyone else. Its access is exactly its environment grants.

## 2. What an identity can do

Machines can hold three permissions and nothing else:

| Permission         | Allows                                         |
| ------------------ | ---------------------------------------------- |
| `environment:read` | See the environment's metadata                 |
| `secret:list`      | List variable names and metadata, never values |
| `secret:runtime`   | Load decrypted values into the calling process |

Write, delete, rollback, reveal, export, approvals and every administrative
permission are impossible for machines, whatever role or scope is chosen.

Effective permissions on an environment are the intersection of:

1. the identity being `ACTIVE`, unexpired and not retired;
2. the credential being unrevoked and unexpired;
3. the access token being unrevoked, unexpired, and (if it was narrowed)
   issued for that environment;
4. the identity's ALLOW grants on that environment, minus its DENY grants
   (DENY wins; expired grants are ignored);
5. the machine permissions above;
6. the scopes of the credential, narrowed by the token.

Everything is evaluated from the database on every request.

## 3. Grants

Grants are `access_policies` rows whose subject is the identity, with an
environment role. Only roles made entirely of machine permissions can be
granted:

| Role                                   | Permissions                                         |
| -------------------------------------- | --------------------------------------------------- |
| Runtime loader (`environment-runtime`) | `environment:read`, `secret:list`, `secret:runtime` |
| Variable lister (`environment-lister`) | `environment:read`, `secret:list`                   |
| Metadata viewer (`environment-viewer`) | `environment:read`                                  |

Custom environment roles qualify when all their permissions are machine
permissions. A foreign key on (workspace, project, identity) makes it
impossible to grant an identity an environment of another project.

Rules for people managing grants:

- `service_identity:manage` on the project and `access_policy:manage` on the
  environment;
- `environment:protect` as well on a protected environment;
- for an ALLOW grant, every permission of the role on that environment
  themselves: a workspace owner or project admin without a direct grant on
  Production cannot give a machine runtime access to Production
  (`GRANT_EXCEEDS_AUTHORITY`, audited as `machine.grant_refused`);
- a recent password confirmation for ALLOW grants;
- removing a DENY widens access, so it needs the same authority and
  confirmation as an ALLOW.

Issuing or rotating a credential follows the same rule: the issuer must hold
what the credential would reach on each granted environment
([service-credentials.md](service-credentials.md#2-issuing)).

Protected environments therefore need a direct, explicit grant from someone
who already holds that access there. There is no step up for machines: the
grant is the deliberate decision.

## 4. Lifecycle

| Action           | Needs                                                                   | Effect                                                                                     |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Create           | `service_identity:manage`                                               | No access until granted                                                                    |
| Rename, describe | `service_identity:manage`                                               |                                                                                            |
| Change expiry    | `service_identity:manage`; password confirmation to remove or extend it |                                                                                            |
| Disable          | `service_identity:manage`                                               | Every access token ends now; exchanges are refused                                         |
| Enable           | `service_identity:manage`, password confirmation                        | New exchanges work again; old tokens stay ended                                            |
| Retire           | `service_identity:manage`                                               | Credentials revoked, tokens ended, grants removed; kept for history; the name becomes free |

`service_identity:read` lets people see identities, grants, credential
metadata and activity. Project Admin, workspace Owner and Admin hold both
permissions; Developers and Viewers hold neither.

## 5. API

Management (people only; machine tokens are refused):

```
GET    /api/v1/workspaces/{w}/projects/{p}/machine-identities?q=&status=&includeRetired=
POST   /api/v1/workspaces/{w}/projects/{p}/machine-identities
GET    /api/v1/workspaces/{w}/projects/{p}/machine-identities/{id}
PATCH  /api/v1/workspaces/{w}/projects/{p}/machine-identities/{id}
POST   …/machine-identities/{id}/disable
POST   …/machine-identities/{id}/enable
DELETE …/machine-identities/{id}                         (retire)
GET    …/machine-identities/{id}/credentials
POST   …/machine-identities/{id}/credentials
POST   …/machine-identities/{id}/credentials/{cid}/rotate
POST   …/machine-identities/{id}/credentials/{cid}/revoke
POST   …/machine-identities/{id}/grants
DELETE …/machine-identities/{id}/grants/{grantId}
GET    …/machine-identities/{id}/activity?cursor=
```

Machine side (machine access tokens only; people's tokens are refused):

```
POST /api/v1/machine/token                                  (service credential)
POST /api/v1/machine/token/revoke
GET  /api/v1/machine/identity
GET  /api/v1/machine/environments
GET  /api/v1/machine/environments/{e}
GET  /api/v1/machine/environments/{e}/variables              (secret:list)
POST /api/v1/machine/environments/{e}/runtime                (secret:runtime)
```

Every route is in the OpenAPI document and the TypeScript SDK
(`listMachineIdentities`, `issueServiceCredential`, `exchangeServiceCredential`,
`machineRuntime` and so on). Responses carry `Cache-Control: no-store`.

## 6. Dashboard

Project → **Machine identities** (`/workspaces/{w}/projects/{p}/machines`):
search and status filter, status badges, per environment access summary,
last use, and a three step creation wizard (details, environment access,
first credential). The identity page shows effective access per
environment, grants, credentials with rotate and revoke, lifecycle actions
and activity. Credentials are shown once, with a required "I stored it"
confirmation, and never again.

## 7. Audit events

All under `resourceType: service_identity` and the identity's id (activity
view), or with the identity as actor (`actorType: SERVICE_IDENTITY`):

| Action                                                                      | Actor   | When                                                                                                 |
| --------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `machine_identity.created`, `.updated`, `.disabled`, `.enabled`, `.retired` | person  | Lifecycle                                                                                            |
| `machine_identity.grant_added`, `.grant_removed`                            | person  | Grant changes (role, effect, protected)                                                              |
| `machine.grant_refused`                                                     | person  | ALLOW beyond the granter's own access                                                                |
| `service_credential.created`, `.rotated`, `.revoked`                        | person  | Credential lifecycle (ids, scopes, expiry)                                                           |
| `service_credential.refused`                                                | person  | Issue or rotation beyond the issuer's own access                                                     |
| `machine.authenticated`                                                     | machine | Successful exchange (scopes, environment count, lifetime)                                            |
| `machine.authentication_failed`                                             | machine | Wrong secret, revoked, expired, disabled, scope not granted (once per credential, reason and minute) |
| `machine.token_rejected`                                                    | machine | Revoked token or credential used (once per token, reason and minute)                                 |
| `machine.token_revoked`                                                     | machine | Token ended by the client                                                                            |
| `machine.access_denied`                                                     | machine | Missing permission on an environment                                                                 |
| `secret.runtime_loaded`                                                     | machine | Values loaded (count and ids, never values)                                                          |
| `security.rate_limited`                                                     | machine | Runtime loads blocked by the limit                                                                   |

No event contains a credential, a token or a value.

## 8. Migration

`20261026090000_machine_identities` extends the Phase 1 placeholder tables in one transaction:

- identities and grants are kept as they are (identities already disabled get a disabled time);
- `API_TOKEN` credentials from before this phase have no keyed digest and no code ever issued
  them, so they are revoked, not deleted, and can only exist in that state; OIDC rows are
  untouched;
- the script stops and changes nothing if an identity has no project or a grant points at
  another project's environment; decide what to do with such rows first;
- nothing outside the `public` schema (such as `neon_auth`) is touched.

Prisma has no down migrations. `packages/database/prisma/rollbacks/20261026090000_machine_identities.down.sql`
reverses the schema (tested); it drops machine access tokens, scopes and identity metadata, and
revoked legacy credentials stay revoked. Run it only after review, with the API stopped. Existing
databases also need `pnpm db:sync-catalog` for the new roles.

## 9. Not included

- Workload identity federation (OIDC from GitHub Actions and others) is not
  implemented. The `service_credentials` table reserves the
  `OIDC_FEDERATION` type for it.
- Deployment synchronization (pushing values to hosting providers) is Phase 5.
- Machines cannot write values; there is no machine write scope.
