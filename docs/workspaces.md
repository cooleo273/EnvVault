# Workspaces, members and invitations

A workspace is EnvVault's tenant. Its projects, environments, roles, invitations and
encryption keys all belong to exactly one workspace. Users join workspaces through
memberships.

Authentication is covered in [authentication.md](authentication.md). This page covers
authorization inside a workspace.

## 1. Roles (RBAC)

Each workspace gets its own copy of four built-in roles (`roles.is_system = true`). The
catalog lives in `packages/database/src/catalog/roles.ts` and is enforced only by the
API.

| Permission                                                       | Owner | Admin | Member | Viewer |
| ---------------------------------------------------------------- | :---: | :---: | :----: | :----: |
| `workspace:read`                                                 |   ✓   |   ✓   |   ✓    |   ✓    |
| `member:read`                                                    |   ✓   |   ✓   |   ✓    |   ✓    |
| `workspace:update`                                               |   ✓   |   ✓   |        |        |
| `member:invite`                                                  |   ✓   |   ✓   |        |        |
| `member:manage`                                                  |   ✓   |   ✓   |        |        |
| `audit:read`                                                     |   ✓   |   ✓   |        |        |
| `role:manage`                                                    |   ✓   |       |        |        |
| `workspace:archive`                                              |   ✓   |       |        |        |
| `workspace:delete`                                               |   ✓   |       |        |        |
| `workspace:transfer`                                             |   ✓   |       |        |        |
| `project:create`                                                 |   ✓   |   ✓   |   ✓    |        |
| Administer all projects and environments (no secrets, no deploy) |   ✓   |   ✓   |        |        |

- **Workspace roles never grant secret, deployment or change-request permissions.** Owner
  and Admin administer project and environment metadata; Members can create projects
  (and become their Project Admin); Viewers see only projects they are added to. Secret
  access comes only from project roles and environment grants. See
  [authorization.md](authorization.md).
- Rules on top of permissions, enforced in the API with the database as a backstop:
  - Nobody changes their own role or removes themselves. Use "transfer ownership" or
    "leave" instead.
  - Only owners can grant the owner role or change or remove an owner. Admins manage
    everyone else.
  - **A live workspace always keeps at least one ACTIVE owner.** A deferred constraint
    trigger (`workspace_memberships_last_owner`) locks the workspace row and rejects any
    commit that would leave no owner. This also covers two concurrent demotions.
  - Ownership transfer requires `workspace:transfer` **and** a fresh password step-up. The
    target becomes owner and the caller becomes admin, in one transaction.

Existing workspaces are brought in line with the catalog by
`pnpm db:sync-catalog`. It is idempotent and safe to run on every deploy: it adds missing
permissions and roles, and removes built-in-role grants that code no longer defines. It
never touches memberships or custom roles.

## 2. Authorization flow

1. `AuthenticationGuard` verifies the Neon Auth JWT. The principal (`userId`) comes only
   from the verified token.
2. `AuthorizationGuard` reads the route's requirement.
   `@RequireWorkspacePermission(permission)` loads the caller's ACTIVE membership in the
   workspace named in the URL:
   - not a member → **404** (whether or not the workspace exists);
   - member without the permission → **403**;
   - workspace archived → **409 `WORKSPACE_ARCHIVED`**, unless the route opts in with
     `@AllowArchivedWorkspace()` (reads, restore, delete, leave).
3. Handlers act only through a `WorkspaceScope` created by the guard. Nested ids (member,
   invitation) are always looked up **within that scope**, so ids from another workspace
   return 404.

## 3. API endpoints (`/api/v1`)

| Method & path                                       | Requirement                                      | Notes                                                              |
| --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `GET /users/me`                                     | authenticated (unverified allowed)               | Profile, workspaces, `activeWorkspaceId`, pending invitation count |
| `PUT /users/me/active-workspace`                    | authenticated + membership                       | Remembers the selection; 404 for non-members                       |
| `POST /auth/logout`                                 | authenticated                                    | See authentication.md                                              |
| `POST /auth/tokens/revoke`                          | authenticated                                    | After password change or ending sessions                           |
| `GET/POST /auth/step-up`                            | authenticated                                    | Password re-verification                                           |
| `GET /workspaces[?archived=include]`                | authenticated                                    | Caller's workspaces                                                |
| `POST /workspaces`                                  | authenticated                                    | Slug optional (generated); 409 `SLUG_TAKEN`                        |
| `GET /workspaces/:id`                               | `workspace:read`                                 | Includes the caller's role and permissions                         |
| `PATCH /workspaces/:id`                             | `workspace:update`                               | Name, description (slug is immutable)                              |
| `POST /workspaces/:id/archive` · `/restore`         | `workspace:archive`                              | 409 if already in that state                                       |
| `DELETE /workspaces/:id`                            | `workspace:delete` + step-up                     | Soft delete                                                        |
| `POST /workspaces/:id/transfer-ownership`           | `workspace:transfer` + step-up                   | `{ membershipId }`                                                 |
| `POST /workspaces/:id/leave`                        | `workspace:read`                                 | 409 `LAST_OWNER` for the last owner                                |
| `GET /workspaces/:id/roles`                         | `member:read`                                    | Assignable workspace roles                                         |
| `GET /workspaces/:id/members`                       | `member:read`                                    |                                                                    |
| `PATCH /workspaces/:id/members/:membershipId`       | `member:manage`                                  | `{ roleKey }`, rules above                                         |
| `DELETE /workspaces/:id/members/:membershipId`      | `member:manage`                                  | Rules above                                                        |
| `GET /workspaces/:id/invitations`                   | `member:invite`                                  | Never includes tokens                                              |
| `POST /workspaces/:id/invitations`                  | `member:invite`                                  | `{ email, roleKey }` (admin, member, viewer)                       |
| `POST /workspaces/:id/invitations/:id/resend`       | `member:invite`                                  | New token and expiry; the old link stops working                   |
| `DELETE /workspaces/:id/invitations/:id`            | `member:invite`                                  | Revoke                                                             |
| `GET /invitations`                                  | authenticated                                    | Pending invitations for the caller's verified email                |
| `POST /invitations/lookup` · `/accept` · `/decline` | authenticated, token in the body                 | Rate limited (`RATE_LIMIT_SENSITIVE_MAX`)                          |
| `POST /invitations/:id/accept` · `/decline`         | authenticated, invitation for the caller's email | In-app acceptance                                                  |

Errors use the standard envelope. Domain codes are listed in
`packages/shared/src/schemas/workspaces.ts` (`WORKSPACE_ERROR_CODES`). Every state change
writes an audit event in the same transaction: `workspace.created`, `.updated`,
`.archived`, `.restored`, `.deleted`, `.ownership_transferred`, `member.invited`,
`.role_changed`, `.removed`, `.left`, `invitation.resent`, `.revoked`, `.accepted`,
`.declined`. Audit metadata never contains tokens, passwords or email bodies.

## 4. Invitations

- **Token:** 32 random bytes (`crypto.randomBytes`), encoded as base64url. Only
  **SHA-256(token)** is stored in `workspace_invitations.token_hash`. The token is never
  logged or audited, and is returned exactly once.
- **Link:** `<APP_BASE_URL>/invite#token=…`. The token is in the URL **fragment**, which
  browsers never send to servers or in `Referer` headers. The invite page moves it to
  `sessionStorage` for the sign-in round trip and removes it from the address bar.
- **Single use and expiry:** acceptance, declining and revocation are conditional
  updates on `status = 'PENDING' AND expires_at > now()`. Only one request can succeed;
  replays get 404 `INVITATION_INVALID`. The default lifetime is 7 days
  (`INVITATION_TTL_HOURS`). At most one pending invitation per email and workspace
  (partial unique index).
- **Bound to an address:** only a signed-in user whose **verified** email equals the
  invited address can view, accept or decline. Anyone else gets 403
  `INVITATION_EMAIL_MISMATCH`, with no workspace details.
- **Email delivery is not configured.** `EMAIL_PROVIDER` only accepts `none`, so the API
  reports `delivery.status = "not_configured"` and returns the link once. The UI says so
  and shows the link to share manually. Invitees can also accept from inside the app (on
  onboarding, `/workspaces` and the dashboard) after signing up with the invited address.
  To add real delivery, implement `Mailer` in `apps/api/src/notifications/mailer.ts`.

## 5. Onboarding and workspace selection

`GET /users/me` returns `activeWorkspaceId`. That is the remembered workspace
(`users.last_workspace_id`) **only if** the user still has an ACTIVE membership in a live,
non-archived workspace; otherwise it is the first accessible workspace, or `null`. The web
app's `/dashboard` uses it as follows (`resolveLanding`, unit tested):

| Situation                                         | Result                                |
| ------------------------------------------------- | ------------------------------------- |
| No workspace                                      | `/onboarding` wizard                  |
| One workspace                                     | Dashboard of that workspace           |
| Several workspaces                                | The remembered one                    |
| Remembered workspace revoked, archived or deleted | Another accessible one, or onboarding |

The selection is updated when a user switches workspaces in the header, creates a
workspace or accepts an invitation. It is a preference, never authorization evidence.

## 6. Archive, restore and delete

- **Archive** (owner): the workspace becomes read-only. It is hidden from the switcher,
  listed under "Archived" on `/workspaces`, and its pending invitations stop working.
- **Restore** (owner): reverses archiving.
- **Delete** (owner + typed slug + password step-up): a soft delete
  (`workspaces.deleted_at`). Data is purged after the recovery window by a maintenance
  job (not implemented yet).

## 7. Not implemented yet

- Workspace logos: no approved object storage exists yet.
- Outbound email (see above).
- Custom roles (`role:manage` is reserved).
- An audit log viewer.
- Secret management (Phase 3).
