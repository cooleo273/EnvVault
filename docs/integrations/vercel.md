# Vercel

Copies an EnvVault environment into a Vercel project's environment variables,
manually, after a preview you confirm.

Related: [docker.md](docker.md), [cloud-runtime.md](cloud-runtime.md),
[ci-security.md](ci-security.md), [../authorization.md](../authorization.md#12-phase-5b-deployment-integrations).

## 1. What it does, and what it does not

- **It copies values out of EnvVault.** In Vercel they are outside EnvVault's
  encryption, access control and audit: Vercel, everyone with access to the
  Vercel project, and every deployment can read them.
- **Manual only.** Nothing is synchronised automatically, on a schedule or
  when a value changes. Each run is previewed and confirmed by a person.
- **Only what EnvVault manages.** EnvVault records the Vercel variables it
  created (or was told to overwrite). It never changes or removes anything
  else in the Vercel project.
- **No values read from Vercel.** EnvVault lists Vercel variables without
  `decrypt=true`; it compares its own versions and Vercel's `updatedAt`, never
  values.
- **New deployments only.** Vercel applies changed variables to deployments
  made afterwards. Redeploy for running deployments to use them.

## 2. Setup

1. In Vercel, create an access token (Account Settings, Tokens) scoped to the
   team that owns the project, with the shortest expiry you can manage.
2. In EnvVault: Project → Integrations → Vercel → **Connect Vercel**. Paste
   the token and the team id (`team_…`; leave it empty for a personal
   account). EnvVault checks the token with Vercel, stores it envelope
   encrypted under the workspace keyring, and never shows it again.
3. **Search** for the Vercel project and **Link** it.
4. **Add mapping**: an EnvVault environment and a Vercel environment
   (Development, Preview, Production, or a custom environment). Preview can be
   limited to one Git branch.
5. **Preview sync**, choose options, confirm. Then redeploy in Vercel.

## 3. Synchronisation

The preview lists, by key:

| Action                       | Meaning                                                             | Written when                                       |
| ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| create                       | Not in Vercel for this target                                       | Always                                             |
| update                       | EnvVault has a newer version than the one last copied               | Always                                             |
| unchanged                    | Same version as last time, untouched in Vercel                      | Never                                              |
| remove                       | Created by EnvVault, but the key is gone from EnvVault              | Only with **remove managed variables**             |
| conflict: unmanaged          | A Vercel variable with this key exists that EnvVault did not create | Only with **overwrite** (EnvVault then manages it) |
| conflict: changed externally | Someone changed EnvVault's variable in Vercel since the last run    | Only with **overwrite**                            |
| conflict: shared target      | The Vercel variable also applies to other environments              | Never; change it in Vercel                         |

Unrelated Vercel variables are counted and left alone.

The confirmation carries the preview's plan hash. If anything changed in
EnvVault or Vercel since the preview, the run is refused
(`SYNC_PLAN_CHANGED`) and nothing is written: preview again.

Variables of type Secret are written as Vercel `sensitive` (not readable in
the Vercel dashboard), except to Development, which Vercel does not allow;
other types as `encrypted`. Each written variable carries the comment
"Managed by EnvVault".

### Partial results

Vercel has no atomic batch for environment variables, so EnvVault writes one
variable per request and records the outcome of each. A run ends as:

- **SUCCEEDED**: every planned change was made;
- **PARTIAL**: some were made, some failed or were not attempted;
- **FAILED**: nothing was made.

The result names every key with `written`, `removed`, `unchanged`, `skipped`,
`failed` (with an error code) or `not_attempted`. Successful writes are
recorded immediately, so the next preview shows only what is still missing,
and retrying is safe. A run stops at a rate limit (the result says when to
retry), an outage, or a refused token; a single rejected variable does not
stop the others. Updates and removals are retried up to twice after an
outage; creates are not, because an unanswered create may have succeeded (the
next preview then shows it as unmanaged).

Only one run per mapping at a time (`SYNC_IN_PROGRESS`). A run abandoned by a
crashed API is released after 15 minutes.

## 4. Permissions

| Action                                                        | Needs                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| See connections, mappings, history                            | `integration:read`                                                                                             |
| Preview                                                       | `integration:read`, and `secret:list` on the environment                                                       |
| Connect, replace token, link, add mapping, enable, disconnect | `integration:manage` and a recent password confirmation                                                        |
| Disable, check, remove mapping                                | `integration:manage`                                                                                           |
| Synchronise                                                   | `integration:manage`, a recent password confirmation, and `secret:read` and `secret:export` on the environment |

Integration settings are not secret access: someone who manages integrations
but cannot export an environment cannot copy it (`403`, audited as
`integration.sync_refused`). Protected environments follow the usual rule:
export needs a direct grant there.

Extra confirmation is required, in the dialog and by the API
(`SYNC_CONFIRMATION_REQUIRED`), to copy a protected environment and to write
to Vercel Production (or a custom environment named `production`).

Built in roles: Project Admin, and workspace Owner and Admin, hold
`integration:read` and `integration:manage` (run `pnpm db:sync-catalog` on
existing databases). Workspace admins hold no secret permissions, so they can
connect and map but not synchronise.

## 5. Security model

| Concern                    | How it is handled                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Vercel token           | Envelope encrypted with the workspace keyring under its own AAD domain and data key purpose, bound to the workspace and connection; decrypted only for a request to Vercel; never returned, logged or audited; erased on disconnect |
| Token scope                | Prefer a team scoped token with an expiry; EnvVault cannot narrow it further                                                                                                                                                        |
| Values in transit          | Sent only to the configured Vercel API over TLS, in request bodies, never in URLs                                                                                                                                                   |
| Values in EnvVault records | Never: job summaries, audit events and errors hold keys, actions and error codes only                                                                                                                                               |
| Reading the values         | Decrypted only for the variables being written, through the vault; `integration.values_exported` is recorded before anything is sent, and the run stops if it cannot be recorded                                                    |
| Provider errors            | Mapped to fixed codes; Vercel's response bodies (which can echo values) are never stored or shown                                                                                                                                   |
| Unrelated variables        | Never changed or removed                                                                                                                                                                                                            |
| Workspaces and projects    | Connections, mappings and managed records are tied to one project by composite foreign keys; ids from elsewhere answer 404                                                                                                          |

## 6. API

All under `/api/v1/workspaces/{workspaceId}/projects/{projectId}/integrations`:
`GET /`, `POST /vercel`, `GET /{id}`, `PUT /{id}/credential`,
`POST /{id}/check`, `POST /{id}/disable`, `POST /{id}/enable`, `DELETE /{id}`,
`GET /{id}/vercel/projects`, `PUT /{id}/vercel/project`,
`GET /{id}/vercel/custom-environments`, `GET|POST /{id}/mappings`,
`DELETE /{id}/mappings/{mappingId}`, `POST /{id}/mappings/{mappingId}/preview`,
`POST /{id}/mappings/{mappingId}/sync`, `GET /{id}/jobs`. TypeScript SDK:
`connectVercel`, `linkVercelProject`, `createIntegrationMapping`,
`previewSync`, `runSync`, `syncJobs` and the others in
[../sdk-typescript.md](../sdk-typescript.md).

Audit events: `integration.connected`, `.credential_replaced`, `.enabled`,
`.disabled`, `.disconnected`, `.project_linked`, `.mapping_created`,
`.mapping_deleted`, `.values_exported`, `.synced`, `.sync_refused`.

## 7. Provider limitations

- No atomic multi variable write (section 3).
- Rate limits: EnvVault honours `Retry-After`, then `X-RateLimit-Reset`.
  Vercel does not document these headers as stable; check them against a real
  response before relying on exact retry times.
- A token cannot be limited to one project; anyone holding it reaches every
  project of the team.
- Vercel's `sensitive` type is not available for Development.
- Changes need a new deployment.
- A Vercel variable shared by several targets is never changed by EnvVault.

## 8. Troubleshooting

| Message                      | Cause                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `PROVIDER_AUTH_FAILED`       | Token revoked or expired in Vercel; the connection shows Error. Replace the token.               |
| `PROVIDER_FORBIDDEN`         | The token cannot reach the team or project. Check the team id and token scope.                   |
| `PROVIDER_NOT_FOUND`         | Project or custom environment does not exist for this token's team.                              |
| `PROVIDER_RATE_LIMITED`      | Wait for the time in the result, then preview and run again.                                     |
| `PROVIDER_UNAVAILABLE`       | Vercel did not answer; try again.                                                                |
| `SYNC_PLAN_CHANGED`          | Preview again and confirm the new plan.                                                          |
| `SYNC_CONFIRMATION_REQUIRED` | Tick the protected or Production confirmation.                                                   |
| `SYNC_IN_PROGRESS`           | Another run of this mapping is going; wait for it.                                               |
| 403 on preview or sync       | You lack `secret:list` (preview) or `secret:read` and `secret:export` (sync) on the environment. |

## 9. API endpoints used

Checked against Vercel's REST API reference on 2026-10-27:
`GET /v2/user`, `GET /v2/teams/{teamId}`, `GET /v10/projects`,
`GET /v9/projects/{idOrName}`, `GET /v9/projects/{idOrName}/custom-environments`,
`GET /v10/projects/{idOrName}/env` (without `decrypt`),
`POST /v10/projects/{idOrName}/env` (one variable per request, without
`upsert`), `PATCH /v9/projects/{idOrName}/env/{id}`,
`DELETE /v9/projects/{idOrName}/env/{id}`. The base URL is `VERCEL_API_URL`
(default `https://api.vercel.com`; plain http only for a loopback mock with
`NODE_ENV=test`).

## 10. Manual acceptance test

Automated tests use a mock Vercel API. Before relying on the integration, run
once against a real Vercel test project with synthetic values:

1. Connect with a team scoped token; the connection shows the team name.
2. Link the test project; map Development to Preview; preview shows creates.
3. Synchronise; the variables appear in Vercel with "Managed by EnvVault",
   Secret types as Sensitive.
4. Add an unrelated variable in Vercel; preview counts it as unrelated; a run
   leaves it untouched.
5. Edit an EnvVault managed variable in Vercel; preview shows "changed in
   Vercel"; a run without overwrite skips it.
6. Delete a variable in EnvVault; a run without removal keeps it in Vercel;
   with removal deletes only it.
7. Revoke the token in Vercel; **Check** shows Error with
   `PROVIDER_AUTH_FAILED`.
8. Redeploy and confirm the deployment reads the new values.
9. Disconnect; the token is erased in EnvVault, the variables stay in Vercel.
