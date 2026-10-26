# Environments

A project can have **any number** of environments with **any names**: Local, Preview,
Demo, QA, Production, and so on. Nothing assumes a fixed set. Each environment has an
independent identity (a UUID), configuration, permissions and lifecycle.

## 1. Identity and naming

| Field           | Rules                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Stable UUID. Integrations and grants reference it                                                                                                          |
| `name`          | Free text, up to 64 characters, unique per project case-insensitively (live rows). **Renaming** (e.g. QA → Quality Assurance) never changes the id or slug |
| `slug`          | Generated from the name and unique per project (`qa`, `qa-2`, …). **Immutable**                                                                            |
| `kind`          | `DEVELOPMENT`, `TESTING`, `STAGING`, `PRODUCTION` or `OTHER`; a classification only                                                                        |
| `color`, `icon` | Visual identifiers from fixed sets                                                                                                                         |
| `sortOrder`     | Display order. Changed with `PUT …/environments/order`; keyboard-accessible move buttons in the UI                                                         |
| `expectedKeys`  | Variable **names** this environment should define, e.g. from a template. Never values; the variables table offers missing ones as one click Add buttons    |

## 2. Lifecycle

| Action    | Effect                                                                                         | Permission                                                                            |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Create    | From scratch, from a template, or as a duplicate                                               | `environment:create` (+ `environment:protect` if protected)                           |
| Update    | Metadata only                                                                                  | `environment:update` (+ `environment:protect` if protected)                           |
| Archive   | `ARCHIVED`: read-only (409 `ENVIRONMENT_ARCHIVED`) and hidden from the default list            | `environment:update` (+ protect if protected)                                         |
| Restore   | Back to `ACTIVE`                                                                               | same                                                                                  |
| Delete    | Soft delete with typed slug confirmation                                                       | `environment:delete`; if protected, also `environment:protect` and a password step-up |
| Duplicate | Same project, same structure (kind, protection, colors, expected keys); never grants or values | `environment:read` + `environment:create`                                             |

An environment in an archived project is read-only as well.

## 3. Templates

- **Built-in** templates are defined in code (`BUILT_IN_ENVIRONMENT_TEMPLATES`):
  Development, QA, Testing, Staging, UAT, Production (protected), Demo and Preview.
- **Workspace templates** live in `environment_templates`. They can define one or many
  environments and are created by workspace admins (`workspace:update`), e.g. "Save as
  template" on an environment.
- A template entry holds a name, suggested slug, kind, description, protection default,
  color, icon and **expected key definitions without values**. Templates never copy
  secrets.
- New projects can start with any selection of template environments (the default is
  Development, Staging and Production) or with none. New environments can be prefilled
  from a template (`?template=builtin:qa`).

## 4. Protection

Protected environments, typically production, get stronger rules:

- Every change requires `environment:protect` (workspace Owner/Admin, Project Admin, or
  a grant that includes it). A Maintainer grant alone is not enough
  (403 `PROTECTION_REQUIRED`).
- **Removing protection** and **deleting** require a fresh password step-up. The UI asks
  for the password and confirms the change.
- Data-plane permissions (secret values, deployment) are **never inherited**. They need
  an explicit grant on the environment.
- Granting or revoking access on a protected environment requires
  `environment:protect`.
- Every protection change is audited: `environment.protected`, `.unprotected`,
  `.protection_updated`.
- **Future approvals:** `required_approvals` (0–10, protected only, enforced by a CHECK
  constraint) and the existing `change_requests` and `change_approvals` tables are the
  data model for the approval workflow of a later phase. The value is stored and shown
  as "planned"; **no approval process runs today.**

## 5. Access grants

Grants are stored in `access_policies`: an environment role granted to a workspace
member, with **ALLOW** or **DENY** effect and an optional expiry. Grant semantics and
inheritance are covered in [authorization.md](authorization.md).

## 6. API (`/api/v1/workspaces/{w}/projects/{p}/environments`)

| Method & path                                                | Permission                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                                      | `project:read`; returns only environments with effective `environment:read`. Filters: `q`, `status`, `kind`; pagination (`pageSize` up to 200) |
| `POST /`                                                     | `environment:create`                                                                                                                           |
| `PUT /order`                                                 | `environment:update`                                                                                                                           |
| `GET /{e}`                                                   | `environment:read` (includes the caller's effective permissions)                                                                               |
| `PATCH /{e}`                                                 | `environment:update` (+ protect)                                                                                                               |
| `PUT /{e}/protection`                                        | `environment:protect` (+ step-up to remove)                                                                                                    |
| `POST /{e}/archive`, `/restore`                              | `environment:update` (+ protect)                                                                                                               |
| `DELETE /{e}`                                                | `environment:delete` (+ protect + step-up if protected)                                                                                        |
| `POST /{e}/duplicate`                                        | `environment:read` + `environment:create`                                                                                                      |
| `GET /{e}/access`                                            | `access_policy:manage`                                                                                                                         |
| `POST /{e}/access`                                           | `access_policy:manage` (+ protect if protected)                                                                                                |
| `DELETE /{e}/access/{grantId}`                               | `access_policy:manage` (+ protect if protected)                                                                                                |
| `GET /workspaces/{w}/environment-templates`                  | workspace member                                                                                                                               |
| `POST`/`DELETE /workspaces/{w}/environment-templates[/{id}]` | `workspace:update`                                                                                                                             |

Audit actions: `environment.created`, `.duplicated`, `.updated` (with
`renamedFrom`/`renamedTo`), `.reordered`, `.protected`, `.unprotected`,
`.protection_updated`, `.archived`, `.restored`, `.deleted`, `.access_granted`,
`.access_revoked`, plus `environment_template.created` and `.deleted`.

## 7. Web routes

| Route                                          | Purpose                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `…/projects/{p}/environments`                  | EnvironmentList: search, type and status filters, reorder, create dialog                              |
| `…/projects/{p}/environments/new[?template=…]` | EnvironmentForm with the template prefilled                                                           |
| `…/projects/{p}/environments/{e}`              | Variables table ([secrets.md](secrets.md)), EnvironmentSelector, details and the caller's permissions |
| `…/projects/{p}/environments/{e}/settings`     | Metadata, inheritance, validation rules, protection, access grants and lifecycle                      |
| `…/projects/{p}/environments/{e}/readiness`    | Readiness report ([configuration-validation.md](configuration-validation.md))                         |
| `…/projects/{p}/environments/{e}/snapshots`    | Snapshots, drift and restore ([configuration-snapshots.md](configuration-snapshots.md))               |
| `…/projects/{p}/compare`                       | Compare two environments ([environment-comparison.md](environment-comparison.md))                     |

Variables are covered in [secrets.md](secrets.md).

## 8. Environment intelligence (Phase 3D)

1. **Comparison**: names and metadata of two environments side by side; values are compared on
   the server only on request and never shown. See
   [environment-comparison.md](environment-comparison.md).
2. **Inheritance**: one base environment (`baseEnvironmentId`), one level, only variables marked
   inheritable and never `SECRET` ones, no protected base, local variables override. See
   [configuration-inheritance.md](configuration-inheritance.md).
3. **Validation and readiness**: per environment rules and a READY, WARNING, BLOCKED or UNKNOWN
   report. See [configuration-validation.md](configuration-validation.md).
4. **Snapshots**: immutable records of names, metadata and version references, with drift
   reports and a previewed, atomic restore. See
   [configuration-snapshots.md](configuration-snapshots.md).
