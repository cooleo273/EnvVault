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

| Permission                                                                | Project Admin | Developer | Viewer | Deployment Operator |
| ------------------------------------------------------------------------- | :-----------: | :-------: | :----: | :-----------------: |
| `project:read`, `project_member:read`, `environment:read`, `secret:list`  |       ✓       |     ✓     |   ✓    |          ✓          |
| `project:update`, `project:archive`, `project:delete`                     |       ✓       |           |        |                     |
| `project_member:manage`, `access_policy:manage`                           |       ✓       |           |        |                     |
| `environment:create/update/delete/protect`                                |       ✓       |           |        |                     |
| `secret:read`, `secret:write` (Phase 3; unprotected only)                 |       ✓       |     ✓     |        |                     |
| `secret:delete`, `secret:rollback`, approvals (Phase 3; unprotected only) |       ✓       |           |        |                     |
| `environment:deploy` (future machine credentials; unprotected only)       |               |           |        |          ✓          |

Creating a project makes the creator its **Project Admin**.

### Environment roles (granted per environment, ALLOW or DENY)

| Role            | Permissions                                                             |
| --------------- | ----------------------------------------------------------------------- |
| Metadata viewer | `environment:read`                                                      |
| Maintainer      | `environment:read`, `environment:update`                                |
| Deployer        | `environment:read`, `secret:list`, `environment:deploy`                 |
| Secret reader   | `environment:read`, `secret:list`, `secret:read` (Phase 3)              |
| Secret writer   | plus `secret:write`, `secret:delete`, `change_request:create` (Phase 3) |
| Approver        | `environment:read`, `secret:list`, `change_request:review` (future)     |

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
| Read secret values (Phase 3)       | `secret:read`                    |
| Write secret values (Phase 3)      | `secret:write`                   |
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

## 6. Extending in Phase 3

Secret routes will use `@RequireEnvironmentPermission('secret:read')` and similar
decorators. The evaluator already applies protection and DENY rules to `secret:*`, so
production values are reachable only through explicit grants. New permissions belong in
`packages/shared/src/domain/permissions.ts`. Classify each as project-, environment- or
data-plane-scoped in `access.ts`, then run `pnpm db:sync-catalog` to update existing
workspaces.
