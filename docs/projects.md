# Projects

A project belongs to exactly one workspace and groups any number of environments. A
composite foreign key `(workspace_id, project_id)` on every child table makes it
impossible for a project's data to reference another workspace.

## 1. Ownership and administration

- The creator becomes the project's **Project Admin**.
- Workspace **Owners and Admins** administer every project through their workspace role
  (shown as "Workspace admin"), but never with secret permissions.
- Everyone else needs an explicit project membership. See [authorization.md](authorization.md).

## 2. Lifecycle

| Status / action | Effect                                                                                                | Permission                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ACTIVE`        | Normal                                                                                                | —                                                                                    |
| Archive         | `ARCHIVED`: the project and its environments are read-only (409 `PROJECT_ARCHIVED`). Reads still work | `project:archive`                                                                    |
| Restore         | Back to `ACTIVE`                                                                                      | `project:archive`                                                                    |
| Delete          | **Soft delete** (`deleted_at`) with typed slug confirmation and a password step-up                    | `project:delete` (+ `environment:protect` if the project has protected environments) |

Deletion does **not** cascade. Environments, memberships, grants and audit history stay
in place, hidden with the project, for the recovery window. A future maintenance job
will purge them, together with Phase 3 secrets and versions. Unique slugs apply to live
projects only, so a deleted project frees its slug.

## 3. Features

- **Slugs** are unique per workspace and generated from the name (`backend`,
  `backend-2`, …) when not given. They are immutable.
- **Visual identity:** an icon and a color from fixed sets (`VISUAL_ICONS`,
  `VISUAL_COLORS`), checked by database constraints.
- **Search, filter, sort and pagination** run server-side: `q` (name, slug,
  description), `status=active|archived|all`, `favorite=true`,
  `sort=name|updated|created|recent`, and `page`/`pageSize` (at most 100). Counts are
  computed in a constant number of queries, with no N+1.
- **Favorites** (`project_favorites`) and **recently opened** (`project_visits`) are
  per-user preferences, never access. A favorite or visit only lists a project while
  the user still has access to it.
- **Duplicate** copies metadata and the environment structure: names, slugs, kinds,
  protection, colors and expected key names. It never copies members, grants or secret
  values. The caller needs `project:read` on the source and `project:create`, and
  becomes Project Admin of the copy.
- **Statistics** come from real records: environment count, protected count and member
  count.
- **Activity** is the project's slice of the append-only audit log (`audit_events`
  filtered by `project_id`). It uses keyset pagination with an opaque cursor, so it
  stays stable while new events are added.

## 4. API (`/api/v1/workspaces/{workspaceId}/projects`)

| Method & path                                    | Permission                               |
| ------------------------------------------------ | ---------------------------------------- |
| `GET /`                                          | workspace member (only visible projects) |
| `POST /`                                         | `project:create`                         |
| `GET /{projectId}`                               | `project:read`                           |
| `PATCH /{projectId}`                             | `project:update`                         |
| `POST /{projectId}/archive`, `/restore`          | `project:archive`                        |
| `DELETE /{projectId}`                            | `project:delete` + step-up               |
| `POST /{projectId}/duplicate`                    | `project:read` + `project:create`        |
| `PUT`/`DELETE /{projectId}/favorite`             | `project:read`                           |
| `POST /{projectId}/visits`                       | `project:read`                           |
| `GET /{projectId}/activity`                      | `project:read`                           |
| `GET /{projectId}/members`                       | `project_member:read`                    |
| `POST /{projectId}/members`                      | `project_member:manage`                  |
| `PATCH`/`DELETE /{projectId}/members/{memberId}` | `project_member:manage`                  |
| `GET /{projectId}/roles`                         | `project:read`                           |

The full contract is published as OpenAPI 3.0 at `GET /api/v1/openapi.json`. It is
generated from the same Zod schemas that validate requests, and a test keeps it in sync
with the registered routes. Audit actions: `project.created`, `.duplicated`,
`.updated`, `.archived`, `.restored`, `.deleted`, `.member_added`,
`.member_role_changed`, `.member_removed`.

## 5. Web routes

| Route                                                | Purpose                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `/workspaces/{id}/projects`                          | List: search, filters, sort, grid/list, favorites, recent |
| `/workspaces/{id}/projects/new`                      | Create, with environment templates                        |
| `/workspaces/{id}/projects/{projectId}`              | Overview: counts, environments, recent activity           |
| `/workspaces/{id}/projects/{projectId}/environments` | Environment list (see [environments.md](environments.md)) |
| `/workspaces/{id}/projects/{projectId}/members`      | Project members and inherited access                      |
| `/workspaces/{id}/projects/{projectId}/activity`     | Full activity log                                         |
| `/workspaces/{id}/projects/{projectId}/settings`     | General settings, duplicate, archive and restore, delete  |

The sidebar's **Projects** entry opens the active workspace's projects.
