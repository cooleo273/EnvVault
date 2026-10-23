# Authorization

Neon Auth proves **who** the caller is ([authentication.md](authentication.md)). EnvVault
decides **what** they may do. Authorization is enforced only by the API. The web app
evaluates the same rules purely to decide what to show.

## 1. Principles

- **Default deny.** Every API route declares a requirement; undeclared routes return 403. Missing memberships, roles or grants mean no access.
- **Server-side only.** The caller's identity comes from the verified token. Workspace,
  project and environment ids in a URL only select the target.
- **Parent-child validation (no IDOR).** Projects are loaded inside their workspace and
  environments inside their project, in a single query. Anything outside that chain is
  answered with **404**, exactly like a missing resource.
- **Not visible → 404, visible but not allowed → 403, archived → 409.**
- **Workspace roles never reveal secrets.** No workspace role carries `secret:*`,
  `environment:deploy` or `change_request:*`.
- **No implicit production secret access.** Protected environments never inherit
  data-plane permissions; those must be granted explicitly.

## 2. Hierarchy

```
workspace membership (role) ──► project access ──► environment permissions
```

1. **Workspace.** An ACTIVE membership whose role grants the workspace permission. See
   [workspaces.md](workspaces.md).
2. **Project access** exists when the caller has either
   - an explicit **project membership** (a project role), or
   - a **workspace role holding `project:read`**: Owner and Admin administer every
     project.

   Project permissions are the project-scoped permissions of the workspace role
   combined with the permissions of the project role.

3. **Environment permissions** are computed from three parts:
   - Start with the project permissions that apply per environment.
   - If the environment is **protected**, remove the data-plane permissions
     (`secret:read`, `secret:write`, `secret:delete`, `secret:rollback`,
     `environment:deploy`, `change_request:apply`).
   - Add the environment's **ALLOW** grants, then remove its **DENY** grants. DENY
     always wins, and expired grants are ignored.

   Without `environment:read`, the environment is hidden (404 and omitted from lists).

The evaluator is a pure function, `evaluateProjectAccess` and
`evaluateEnvironmentPermissions` in `packages/shared/src/domain/access.ts`. It is
unit-tested and also covered by mutation-checked API integration tests.

## 3. Roles

### Workspace roles (per workspace)

| Permission                                                                                                       | Owner | Admin | Member | Viewer |
| ---------------------------------------------------------------------------------------------------------------- | :---: | :---: | :----: | :----: |
| Workspace read, member read                                                                                      |   ✓   |   ✓   |   ✓    |   ✓    |
| Workspace settings, invitations, member management, audit read                                                   |   ✓   |   ✓   |        |        |
| `project:create`                                                                                                 |   ✓   |   ✓   |   ✓    |        |
| Administer all projects (`project:*`, `project_member:*`, `environment:*` except deploy, `access_policy:manage`) |   ✓   |   ✓   |        |        |
| Archive, delete or transfer the workspace                                                                        |   ✓   |       |        |        |
| Any `secret:*`, `environment:deploy`, `change_request:*`                                                         |   ✗   |   ✗   |   ✗    |   ✗    |

### Project roles (per project membership)

| Permission                                                               | Project Admin | Developer | Viewer | Deployment Operator |
| ------------------------------------------------------------------------ | :-----------: | :-------: | :----: | :-----------------: |
| `project:read`, `project_member:read`, `environment:read`, `secret:list` |       ✓       |     ✓     |   ✓    |          ✓          |
| `project:update`, `project:archive`, `project:delete`                    |       ✓       |           |        |                     |
| `project_member:manage`, `access_policy:manage`                          |       ✓       |           |        |                     |
| `environment:create/update/delete/protect`                               |       ✓       |           |        |                     |
| `secret:read`, `secret:write` (unprotected only)                         |       ✓       |     ✓     |        |                     |
| `secret:delete`, `secret:rollback`, approvals (unprotected only)         |       ✓       |           |        |                     |
| `environment:deploy` (future machine credentials; unprotected only)      |               |           |        |          ✓          |

Creating a project makes the creator its **Project Admin**.

### Environment roles (granted per environment, ALLOW or DENY)

| Role            | Permissions                                                         |
| --------------- | ------------------------------------------------------------------- |
| Metadata viewer | `environment:read`                                                  |
| Maintainer      | `environment:read`, `environment:update`                            |
| Deployer        | `environment:read`, `secret:list`, `environment:deploy`             |
| Secret reader   | `environment:read`, `secret:list`, `secret:read`                    |
| Secret writer   | plus `secret:write`, `secret:delete`, `change_request:create`       |
| Approver        | `environment:read`, `secret:list`, `change_request:review` (future) |

Examples:

- Developer on **Development** gets Maintainer (ALLOW), giving metadata management.
- Developer on **Production** gets Metadata viewer (DENY). Production is then hidden.
- DevOps gets Maintainer on Development and QA, plus Deployer on Production. That is the
  only way to deploy to a protected environment.

## 4. Separated permissions

| Capability                         | Permission                       |
| ---------------------------------- | -------------------------------- |
| Read environment metadata          | `environment:read`               |
| Edit environment metadata          | `environment:update`             |
| Manage protection                  | `environment:protect`            |
| Manage environment access (grants) | `access_policy:manage`           |
| Read secret values                 | `secret:read`                    |
| Write secret values                | `secret:write`                   |
| Deploy with machine credentials    | `environment:deploy` (future)    |
| Approve protected changes          | `change_request:review` (future) |

## 5. Escalation guards

- Nobody changes their own project role or their own environment grants
  (`CANNOT_CHANGE_OWN_ACCESS`).
- Project members must be ACTIVE members of the same workspace, enforced by a composite
  foreign key. External identities can join only through a workspace invitation.
- Environment grants can target only people who already have access to the project.
- Granting or revoking access on a **protected** environment requires
  `environment:protect`.
- Protected environments: every metadata change needs `environment:protect`. Removing
  protection or deleting the environment also needs a fresh password step-up. Creating
  or duplicating a protected environment needs `environment:protect`.
- Removing someone from a workspace removes their project memberships and environment
  grants (cascade). Removing someone from a project removes their grants in that
  project.

## 6. Secret permissions (Phase 3B and 3C)

Secret routes are guarded by `@RequireEnvironmentPermission('secret:list')`; the data plane
permission of each operation is checked by `SecretAuthorizationService`, which audits every
refusal as `secret.access_denied`. The catalog names are unchanged, plus `secret:export`:

| Operation                               | Permission                      | Inherited into protected environments |
| --------------------------------------- | ------------------------------- | :-----------------------------------: |
| List, read metadata and version history | `secret:list`                   |                  yes                  |
| Reveal a current or historical value    | `secret:read`                   |      no (explicit grant needed)       |
| Create, update, import                  | `secret:write`                  |      no (explicit grant needed)       |
| Delete, restore (single and bulk)       | `secret:delete`                 |      no (explicit grant needed)       |
| Roll back to an earlier version         | `secret:rollback`               |      no (explicit grant needed)       |
| Bulk export (download)                  | `secret:export` + `secret:read` |      no (explicit grant needed)       |

`secret:export` is separate on purpose: reading values one at a time never implies a bulk
download. Phase 3C role changes: Project Admin gains `secret:export`; the Secret writer
environment role gains `secret:rollback`; a new **Secret exporter** environment role holds
`environment:read`, `secret:list`, `secret:read` and `secret:export`. Developers keep read and
write only. Run `pnpm db:sync-catalog` to apply the changes to existing workspaces.

Reading plaintext in a protected environment (reveals, historical reveals, comparisons,
exports and value comparing import previews) additionally needs a recent password step up
(`STEP_UP_REQUIRED` otherwise). Plaintext reads are also rate limited per user and per
variable ([secrets.md, section 10](secrets.md#10-rate-limits)). Workspace roles carry no
`secret:*` permission at all, so an Owner or Admin who is not a project member cannot even list
variables. Bulk requests are refused whole if any id belongs to another environment.

## 7. Environment intelligence permissions (Phase 3D)

Phase 3D reuses the existing catalog; no permission or role was added, so no catalog sync is
needed. Each operation maps to the permission that already governs the same data:

| Operation                                       | Permission                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Compare metadata of two environments            | `secret:list` on both                                                                              |
| Compare values (environments or snapshots)      | `secret:read` on both, step up if protected, `bulk-read` limit                                     |
| Read the effective configuration                | `secret:list` (inherited rows also need `secret:list` on the base)                                 |
| Set or remove the base environment              | `environment:update` (+ `environment:protect` if protected), `secret:list` on the base             |
| Read validation rules, run readiness            | `secret:list`                                                                                      |
| Change validation rules                         | `environment:update` (+ `environment:protect` if protected)                                        |
| Readiness with value inspection                 | `secret:read`, step up if protected, `bulk-read` limit                                             |
| List and read snapshots, drift, restore preview | `secret:list`                                                                                      |
| Take a snapshot                                 | `secret:write`                                                                                     |
| Restore a snapshot                              | `secret:write` + `secret:rollback` (+ `secret:delete` to delete or undelete), step up if protected |

Refusals of data plane permissions are audited as `secret.access_denied`, like every other
secret operation. An environment the caller cannot see answers 404, and a base the caller
cannot read is shown as **Restricted environment** without its name.

## 8. Phase 3E changes

No permission or role was added. What changed is when and how often the existing rules are
applied:

| Area                                     | Rule                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Retention policy (read, change, preview) | `workspace:update`; including protected environments needs a step up                                                            |
| Retention purge                          | `workspace:delete` (Owner), step up, workspace slug typed as confirmation                                                       |
| Long mutations                           | Import commit, bulk changes, rollback and snapshot restore evaluate permissions again inside the write transaction              |
| Refusals                                 | 403 at the request guard is audited as `authz.denied`, once per user, route and minute                                          |
| Rate limits                              | Per user limits on grants, revocations, member and role changes, invitations and step up, counted after authorization           |
| Operator tooling                         | `pnpm ops` runs with database and key file access on the host; it is outside the role model and must be restricted to operators |

Unchanged and verified by tests: workspace roles carry no secret permission, protected
environments never inherit data plane permissions, DENY wins, expired grants are ignored,
removed members lose access on their next request, another tenant's ids answer 404, and
nobody can change their own role or grants.

New permissions belong in `packages/shared/src/domain/permissions.ts`. Classify each as
project, environment or data plane scoped in `access.ts`, then run `pnpm db:sync-catalog` to
update existing workspaces.

## 9. Phase 4A changes (CLI)

One permission was added: **`secret:runtime`**, which lets `envvault run` load decrypted
values of an environment into a child process (`POST …/environments/:id/runtime`).

| Role                            | `secret:runtime` | Notes                                                        |
| ------------------------------- | :--------------: | ------------------------------------------------------------ |
| Project Admin                   |       yes        |                                                              |
| Project Developer               |       yes        | Developers run their apps; they still cannot export          |
| Environment reader              |       yes        |                                                              |
| Environment writer              |       yes        |                                                              |
| Secret exporter                 |        no        | Export and runtime loading are granted separately on purpose |
| Project Viewer, workspace roles |        no        |                                                              |

- `secret:runtime` is data plane scoped: it is never inherited into protected environments,
  so a protected environment needs a direct ALLOW grant that includes it, plus a recent
  step up. DENY, grant expiry and membership removal apply as for every other permission.
- `secret:export` does not imply `secret:runtime`, and `secret:runtime` does not imply
  `secret:export` or `secret:read` (reveal). `envvault pull` uses the existing export route
  and therefore needs `secret:export` and `secret:read`.
- Inherited values are included in a runtime load only when the caller also has
  `secret:runtime` on the base environment; otherwise they are withheld and counted.
- Refusals are audited as `secret.access_denied`, loads as `secret.runtime_loaded` (ids and
  counts only).
- CLI tokens carry the person's identity but are accepted only on routes marked
  `@AllowCliToken()`; nothing that changes roles, grants or membership is reachable with
  one. See [cli-authentication.md](cli-authentication.md#4-what-a-cli-token-may-do).

The permission key is `secret:runtime` rather than `secret:runtime:read` because catalog keys
have exactly one `resource:action` separator (database check constraint). Existing
workspaces need `pnpm db:sync-catalog` for the role changes.
