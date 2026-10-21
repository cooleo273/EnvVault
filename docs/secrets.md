# Secrets and environment variables

An environment holds **variables**: a name, metadata and an encrypted value with a version
history. This document covers the lifecycle, types, API, authorization and UI. The
cryptography is in [encryption.md](encryption.md), key storage in
[key-management.md](key-management.md).

> **Status (Phase 3C).** Variables are stored in PostgreSQL and every value goes through the
> Phase 3A envelope encryption, including imports and rollbacks. Keys come from the **self
> managed development keyring**, which is not a production key store. Use synthetic values
> only until a managed KMS provider is in place and reviewed. Phase 3B and 3C were tested
> against local PostgreSQL only; see section 13 for the checks still owed on Neon.

## 1. Data model

`secrets` holds metadata only; values live in `secret_versions`.

| Column (`secrets`)                                                     | Meaning                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `id`                                                                   | UUIDv7, stable for the life of the variable                       |
| `workspace_id`, `project_id`, `environment_id`                         | Scope; a composite foreign key ties all three together            |
| `key`                                                                  | Variable name, unique among live variables of the environment     |
| `description`                                                          | Up to 1000 characters                                             |
| `type`                                                                 | `STRING`, `SECRET`, `BOOLEAN`, `NUMBER`, `JSON`, `MULTILINE`      |
| `category`                                                             | Optional label, up to 64 characters                               |
| `tags`                                                                 | Up to 20 lowercase labels                                         |
| `is_required`                                                          | The application expects the variable to be set                    |
| `current_version_id`                                                   | Current `secret_versions` row, or null when no value was ever set |
| `latest_version_number`                                                | Version number allocator                                          |
| `revision`                                                             | Optimistic concurrency token, incremented by every change         |
| `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at` | Attribution                                                       |
| `deleted_at`, `deleted_by_user_id`                                     | Soft deletion                                                     |

`secret_versions` rows are immutable (a trigger allows only the wrapped data key and its key
reference to change, for rewrapping). Each row stores the envelope: `ciphertext`, `iv`,
`auth_tag`, `encrypted_data_key`, `algorithm`, `envelope_version`, `kms_key_version` and a
reference to the workspace's `encryption_keys` row, which names the provider and key id.
There is no plaintext column anywhere.

Since migration `20261022090000_secret_version_history` each version also records its
provenance, covered by the same immutability trigger:

| Column (`secret_versions`) | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `origin`                   | `CREATE`, `UPDATE`, `IMPORT` or `ROLLBACK`                                                    |
| `change_reason`            | Optional note from the author, up to 500 characters (never a secret)                          |
| `restored_from_version_id` | For rollbacks only (CHECK): an earlier version of the **same** secret (composite foreign key) |

Existing versions were backfilled: version 1 as `CREATE`, later ones as `UPDATE`.

**Integrity rules in the database:** names must match `^[A-Za-z_][A-Za-z0-9_]*$`; a partial
unique index (`secrets_environment_key_live_key`) makes names unique per environment among
live rows, so the same name can exist in other environments and a deleted name can be reused;
the current version must belong to the same secret (composite foreign key); version numbers
are unique per secret; tags are capped at 20; categories are trimmed.

**Retention:** every encrypted version is kept, including after a soft delete, an import
overwrite or a rollback. Nothing is purged yet; purge and retention policies come with later
hardening work. Versions are never modified (only rewrapped) and never deleted on their own.
Deleting an environment or workspace cascades to its variables only when the row is purged,
never on soft deletion.

Migration `20261021090000_secrets_crud` replaced the earlier `SecretType` values. Existing
rows were converted, not dropped: `GENERIC` → `STRING`, `JSON` → `JSON`, `CERTIFICATE` and
`PRIVATE_KEY` → `MULTILINE`, everything else → `SECRET`.

## 2. Lifecycle

```
create ──► v1 (or no value) ──► update value ──► v2, v3 … (history kept)
   │                               │
   │                               └── metadata only edit: no new version, no decryption
   ▼
soft delete ──► hidden from the live list, versions kept ──► restore (name must be free)
```

**Create.** The API validates the input, checks `secret:write`, chooses the secret id and the
version id, encrypts the value (the ids are bound into the ciphertext), then inserts the
metadata, the version and the audit event in one transaction. If encryption fails nothing is
written, so a variable can never exist with an unencrypted value. Omitting `value` creates a
variable without a value; `""` is a real, empty value.

**Update.** Every update carries `expectedRevision`. The row is updated only if the revision
still matches, so two editors cannot silently overwrite each other: the second gets
`409 SECRET_CONFLICT`. A new value creates a new immutable version: the version number is
allocated by the same row locking `UPDATE`, the version is inserted and the current pointer
moves, all in one transaction. Metadata changes never decrypt or rewrite the value.

**Delete and restore.** Deletion sets `deleted_at` and `deleted_by_user_id`. Restoring clears
them; if another live variable now uses the name, the API answers
`409 SECRET_KEY_TAKEN`.

## 3. Types and validation

The type describes the expected format and how the UI presents the value. Every type is
encrypted the same way; no type stores plaintext.

| Type        | Accepts                                                                       | Empty value |
| ----------- | ----------------------------------------------------------------------------- | :---------: |
| `STRING`    | Any text                                                                      |     yes     |
| `SECRET`    | Any text (credentials, connection strings); the default type                  |     yes     |
| `BOOLEAN`   | `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off` (any case)                |     no      |
| `NUMBER`    | Finite decimals: `42`, `-7`, `3.14`, `1e3`; not `01`, `.5`, `NaN`, `Infinity` |     no      |
| `JSON`      | Any valid JSON document                                                       |     no      |
| `MULTILINE` | Text with line breaks (certificates, private keys)                            |     yes     |

Rules for every value: well formed Unicode (lone UTF-16 surrogates are rejected), at most
**64 KiB of UTF-8**, stored byte for byte. The JSON request body limit is 100 kB, so values
near the limit that need heavy JSON escaping are rejected with 413.

**Names** follow the .env convention: an ASCII letter or underscore, then letters, digits and
underscores, at most 256 characters. Case is preserved and significant, as in POSIX shells.

**Changing the type** to `BOOLEAN`, `NUMBER` or `JSON` of a variable that has a value requires
a new value (`400 SECRET_VALUE_REQUIRED`). Checking the stored value would mean decrypting it.

Validation errors name the field and the rule. They never repeat the submitted value.

The rules live in `packages/shared/src/domain/secrets.ts` and
`packages/shared/src/schemas/secrets.ts`; the API enforces them and the web app uses the same
code for early feedback.

## 4. API

Base path: `/api/v1/workspaces/{w}/projects/{p}/environments/{e}/secrets`. Every response,
including errors, carries `Cache-Control: no-store, max-age=0`. Requests that carry or return
values are POST, so values never appear in a URL, a log line or a proxy cache key.

| Method and path                          | Permission                        | Notes                                                              |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `GET /`                                  | `secret:list`                     | Metadata page; never decrypts                                      |
| `POST /`                                 | `secret:write`                    | `{ key, value?, type, description?, category?, tags, isRequired }` |
| `GET /{id}`                              | `secret:list`                     | Metadata                                                           |
| `PATCH /{id}`                            | `secret:write`                    | `{ expectedRevision, …changes, value?, changeReason? }`            |
| `DELETE /{id}`                           | `secret:delete`                   | Soft delete; optional `?expectedRevision=`                         |
| `POST /{id}/restore`                     | `secret:delete`                   | 409 when the name is taken                                         |
| `POST /{id}/reveal`                      | `secret:read`                     | Current value; audited; rate limited; step up when protected       |
| `GET /{id}/versions`                     | `secret:list`                     | History page: `?limit=20&before=<version>`; never values           |
| `POST /{id}/versions/{versionId}/reveal` | `secret:read`                     | One historical value; same checks as a reveal                      |
| `POST /{id}/versions/compare`            | `secret:read`                     | `{ fromVersionId, toVersionId }` → same value or not; no values    |
| `POST /{id}/rollback`                    | `secret:rollback`                 | `{ versionId, expectedRevision, changeReason? }`                   |
| `POST /import/preview`                   | `secret:write`                    | `{ content, defaultType }` → entries and statuses, no values       |
| `POST /import`                           | `secret:write`                    | `{ content, items, category?, tags?, changeReason? }`              |
| `POST /export`                           | `secret:read` + `secret:export`   | `{ format, secretIds? }` → file content                            |
| `GET /selection`                         | `secret:list`                     | Ids and revisions of every match of the list filters               |
| `POST /bulk`                             | `secret:delete` or `secret:write` | `{ action: delete                                                  | restore | update, items, patch? }` |

List query: `page`, `pageSize` (at most 100), `q` (name or description, case insensitive),
`type=SECRET,JSON`, `category=Database,none` (`none` means uncategorised), `tag`,
`status=active|deleted`, `sort=name|type|category|created|updated`, `order=asc|desc`. The
response adds `facets` (categories and tags in use) for the filters.

Errors: `SECRET_KEY_TAKEN`, `SECRET_CONFLICT` (stale `expectedRevision`), `SECRET_NOT_DELETED`,
`SECRET_VALUE_NOT_SET`, `SECRET_VALUE_REQUIRED`, `SECRET_IMPORT_REJECTED` (with per key
`issues`), `SECRET_IMPORT_TOO_LARGE` (413), `SECRET_BULK_TOO_LARGE`, `SECRET_ROLLBACK_NOOP`,
`SECRET_ROLLBACK_TYPE_MISMATCH`, `ENCRYPTION_UNAVAILABLE` (503), `SECRET_INTEGRITY_ERROR`
(500), `AUDIT_UNAVAILABLE` (503: the value was withheld because its read could not be
recorded), `TOO_MANY_REQUESTS` (429 with `Retry-After`), plus `NOT_FOUND`, `FORBIDDEN` and
`STEP_UP_REQUIRED`. Crypto details never reach clients.

The SDK has a method per route (`listSecrets`, `revealSecret`, `listSecretVersions`,
`revealSecretVersion`, `compareSecretVersions`, `rollbackSecret`, `previewSecretImport`,
`importSecrets`, `exportSecrets`, `secretSelection`, `bulkSecrets` and the CRUD methods). All
routes are in the OpenAPI document at `/api/v1/openapi.json`.

## 5. Import

**Supported syntax** is exactly that of `dotenv` 17 (the parser the API uses):

- `KEY=value` and `KEY: value`, one per line; an optional leading `export`.
- `#` starts a comment on its own line, and after an unquoted value. An unquoted value ends at
  the first `#` (`A=abc#def` is `abc`); quote values that contain `#`.
- Unquoted values are trimmed. `'single'`, `"double"` and `` `backtick` `` quotes keep
  everything inside, including leading and trailing spaces and line breaks (quoted values
  may span lines).
- In double quotes, `\n` and `\r` become a line break and a carriage return. Nothing else is
  unescaped (`\"` keeps its backslash), and nothing is unescaped in other quotes.
- **Nothing is evaluated.** `$VAR`, `${VAR}`, `$(command)` and backticks are kept as text.
  There is no variable expansion and no command substitution.
- Names that do not follow the EnvVault naming rule (for example `my-key` or `a.b`) are shown
  as invalid and cannot be imported. Lines that are not assignments are listed as ignored.
- If a name appears more than once, the last definition is used and the earlier ones are
  shown as duplicates.

**Workflow.** The wizard reads a pasted text or a chosen file in the browser and sends it to
`import/preview`. The preview lists every entry with its line, status (`new`, `changed`,
`unchanged`, `exists`, `invalid`, `duplicate`), resulting type and value size, never the
value. New entries default to Create, existing ones to Skip; the user can switch to
Overwrite per entry or in bulk. `import` parses the content again on the server and applies
the selection.

**Comparing with existing values** (`changed` versus `unchanged`) needs `secret:read`, and a
recent step up in protected environments, because the answer is derived from the stored
plaintext. Without it, existing entries show as `exists` and are not compared. Comparisons use
a constant time equality check and count against the bulk read rate limit.

**Security.** The content is parsed in memory and dropped; it is never written to disk,
logged, cached or stored, and the web app keeps it only in the wizard's state. Every value is
encrypted (origin `IMPORT`) **before** the transaction starts. Every entry is checked again at
commit: a create whose name now exists, an overwrite whose `expectedRevision` is stale, or a
value that does not fit the variable's type rejects the **whole** import (409 or 400 with
`issues` naming the keys). The writes are one transaction: either every selected variable
changes or none does. Concurrent edits are caught by the revision check inside that
transaction.

**Limits** (API configuration): `SECRET_IMPORT_MAX_BYTES` (default 256 KiB, at most 1 MiB),
`SECRET_IMPORT_MAX_ENTRIES` (default 500, at most 2000). The import routes accept JSON bodies
up to twice the byte limit; every other route keeps the 100 kB limit.

## 6. Export

`export` returns the decrypted file content of the current values as `.env`, JSON or YAML.

- Needs **`secret:export` in addition to `secret:read`**. Reading values one at a time never
  implies a bulk download. In protected environments both must come from a direct grant (the
  **Secret exporter** environment role) and a recent step up is required.
- Without `secretIds` every live variable with a value is exported; with them, every id must be
  a live variable of this environment or the request is refused (404) instead of silently
  exporting less. At most `SECRET_EXPORT_MAX_ITEMS` (default 1000) per export.
- `.env` output quotes values so that importing the file gives back exactly the same values.
  Values that no quoting style can hold exactly (for example one containing `'`, `"`, a
  backtick and a line break) are **left out** and listed in `skipped` and `warnings`, rather
  than written corrupted; export those as JSON or YAML. Variables without a value are skipped.
- YAML quotes every key and value (so `on`, `yes` or `null` stay strings) and escapes
  characters YAML treats as line breaks.
- Filenames are `<environment slug>.env|json|yaml` (browsers strip a leading dot from
  download names, so `.env.<slug>` is not used).
- The content is built in memory, returned once with `no-store`, never stored or logged. The
  web app passes it straight to a browser download and asks the user to confirm that the file
  holds plaintext secrets. **A downloaded file is outside EnvVault's protection**: keep it out
  of version control, chat and shared folders, and delete it when done.
- Every export is audited (`secret.export_requested`, then `secret.exported` with the format,
  count and every exported secret id, or `secret.export_failed`). If the success event cannot
  be written, no content is returned.

## 7. History and rollback

**History** (`GET /{id}/versions`) lists versions newest first with keyset pagination
(`limit`, `before` from `nextBefore`): number, origin, change note, the version a rollback
restored, the key version that wraps it, author, time and whether it is current. Listing never
decrypts.

**Historical reveal** needs `secret:read`, a step up in protected environments, counts against
the reveal rate limits and is audited as `secret.version_revealed`. **Compare** decrypts two
versions on the server and returns only whether they are equal and their sizes; it has the
same requirements. The web app can additionally show a line diff, which reveals both values
(two audited reveals) and clears them after 30 seconds.

**Rollback** (`POST /{id}/rollback`, `secret:rollback`):

1. Checks the permission (protected environments: direct grant only) and `expectedRevision`.
2. Decrypts the chosen version **on the server only**; the value is never returned.
3. Checks it against the variable's current type (`SECRET_ROLLBACK_TYPE_MISMATCH` otherwise).
4. Encrypts it again under the **active** key version as a new version (origin `ROLLBACK`,
   `restored_from_version_id` set), so a rollback after a key rotation produces a version
   wrapped by the new key.
5. Moves the current pointer in the same transaction as the revision check, so concurrent
   rollbacks or edits cannot overwrite each other (one wins, the other gets 409).
6. Audits `secret.rolled_back` with the restored, previous and new version numbers.

The source version and every other version stay unchanged. Rolling back to the current
version is refused (`SECRET_ROLLBACK_NOOP`).

## 8. Bulk operations

`POST /bulk` deletes, restores or changes metadata (category, added and removed tags,
required) of up to `SECRET_BULK_MAX_ITEMS` (default 500) variables. Values are never touched.

- Every item names the variable **and the revision the caller saw**. The whole batch is
  refused if any id is not a variable of this environment (404, so ids from another tenant,
  project or environment cannot be mixed in), if any is in the wrong state, if any changed
  meanwhile (409), or, for restores, if any name is in use. Otherwise all changes are one
  statement in one transaction.
- Delete and restore need `secret:delete`; metadata changes need `secret:write`.
- `GET /selection` returns the ids and revisions of **every** variable matching the list
  filters (not just one page), capped at the bulk limit with `truncated` set when more match.
  The UI uses it for Select all matching.
- The UI asks for typed confirmation (`delete N`) before a bulk delete.

## 9. Authorization

The catalog keeps its Phase 2 names, plus **`secret:export`** (Phase 3C).

| Capability                   | Permission                          |
| ---------------------------- | ----------------------------------- |
| Read metadata and history    | `secret:list`                       |
| Read values (current or old) | `secret:read`                       |
| Create, update, import       | `secret:write`                      |
| Delete, restore              | `secret:delete`                     |
| Roll back                    | `secret:rollback`                   |
| Bulk download                | `secret:export` (and `secret:read`) |

Built in roles: Project Admin holds all of them (unprotected environments only); Developer
holds read and write but not delete, rollback or export; Viewer holds list only. Environment
roles: **Secret writer** now includes `secret:rollback`; the new **Secret exporter** role holds
read and export. Run `pnpm db:sync-catalog` after deploying to update existing workspaces.

Every secret route requires `secret:list` through the global guard, which loads the caller's
membership, project role and grants from the database on each request. The data plane
permissions are then checked per operation by `SecretAuthorizationService`, which records a
`secret.access_denied` audit event for each refusal.

- **Workspace roles never grant secret permissions.** An Owner or Admin who administers a
  project through the workspace role cannot list, reveal, import or export its variables.
- **Protected environments never inherit** `secret:read`, `secret:write`, `secret:delete`,
  `secret:rollback` or `secret:export`, not even from Project Admin.
- **Reads of plaintext in protected environments also need a recent step up** (password
  confirmation, `POST /auth/step-up`, valid for `AUTH_STEP_UP_TTL_SECONDS`, 10 minutes by
  default): reveals, historical reveals, comparisons, exports and import comparisons.
- DENY grants override ALLOW; expired grants are ignored; removing a project member or a
  workspace member takes effect on the next request.
- Every lookup is scoped by workspace, project and environment together: an id from another
  tenant, project or environment is `404`, like a missing variable.

## 10. Rate limits

Per user limits, configurable, checked after authorization (a 429 never tells someone without
access whether a variable exists):

| Variable                            |       Default | Counts                                                      |
| ----------------------------------- | ------------: | ----------------------------------------------------------- |
| `SECRET_REVEAL_RATE_LIMIT`          | 60 per minute | Reveals, historical reveals and comparisons of any variable |
| `SECRET_REVEAL_RESOURCE_RATE_LIMIT` | 20 per minute | The same, for one variable                                  |
| `SECRET_BULK_READ_RATE_LIMIT`       | 10 per minute | Exports and value comparing import previews                 |
| `SECRET_IMPORT_RATE_LIMIT`          | 10 per minute | Import commits                                              |
| `SECRET_BULK_WRITE_RATE_LIMIT`      | 20 per minute | Bulk updates, deletes and restores                          |
| `SECRET_ROLLBACK_RATE_LIMIT`        | 30 per minute | Rollbacks                                                   |

Exceeding a limit blocks that counter until its window ends (429 with `Retry-After`) and
records one `secret.access_denied` event with `reason: rate_limited` per block. Counters are
shared between API instances when `RATE_LIMIT_STORE=redis`; if Redis is unreachable these
actions are refused (503 `RATE_LIMIT_UNAVAILABLE`) rather than counted per instance. Other
limits are in [security-hardening.md, section 5](security-hardening.md#5-controls-added-or-verified).

**Retries.** Create, update, delete, restore, rollback, import commit and bulk routes accept
`Idempotency-Key`; the web server sends one with every such call and retries once with the
same key after a network failure, so a change is never applied twice.

**Access checked again before writing.** Import commits, bulk changes and rollbacks evaluate
the caller's permissions again inside the write transaction; a revocation in the meantime
stops the change (403, audited with `reason: access_changed`).

**Retention.** Deleted variables and old versions can be purged by a workspace retention
policy ([operational-runbook.md, section 6](operational-runbook.md#6-retention)). Versions a
snapshot or a later rollback still needs, and current versions, are never purged.

## 11. Audit events

Written to `audit_events` with the actor, the workspace, project and environment, the
resource and the request id. Metadata holds names, version numbers, counts, ids and error
categories, never values, file contents or request bodies.

| Action                                                                                          | Outcome          | Notes                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `secret.created`, `secret.updated`, `secret.value_changed`, `secret.deleted`, `secret.restored` | SUCCESS          | In the transaction of the change                                                                       |
| `secret.revealed`, `secret.version_revealed`, `secret.versions_compared`                        | SUCCESS          | Written before the value or answer is returned; if it fails nothing is returned                        |
| `secret.rolled_back`                                                                            | SUCCESS          | In the transaction; restored, previous and new version                                                 |
| `secret.import_previewed`                                                                       | SUCCESS          | Counts per status, whether values were compared                                                        |
| `secret.import_started`, `secret.import_completed`, `secret.import_failed`                      | SUCCESS, FAILURE | Completed is in the transaction, with every created or updated id                                      |
| `secret.export_requested`, `secret.exported`, `secret.export_failed`                            | SUCCESS, FAILURE | Format, count and every exported id                                                                    |
| `secret.bulk_deleted`, `secret.bulk_restored`, `secret.bulk_updated`                            | SUCCESS          | In the transaction, with every id and the changed fields                                               |
| `secret.batch_items`                                                                            | as above         | Continuation of a batch event: ids beyond the first 250, same `batchId`                                |
| `secret.access_denied`                                                                          | DENIED           | Permission, step up or rate limit refusals                                                             |
| `secret.encryption_failed`, `secret.decryption_failed`                                          | FAILURE          | Crypto error code only                                                                                 |
| `authz.denied`, `security.rate_limited`                                                         | DENIED           | Refusals at the request guard and rate limited sensitive actions, once per minute                      |
| `encryption.*`, `retention.*`                                                                   | SUCCESS, FAILURE | Operator and background events (rotation, rewrap, backups, purges); actor `SYSTEM` for background work |

Every event is sealed into its workspace's MAC chain shortly after it is written
([security-hardening.md, section 7](security-hardening.md#7-audit-integrity)).

Audit metadata is limited to 16 KB per event, so batch events carry at most 250 ids each and
continue in `secret.batch_items` events. Because mutation events share the transaction, a
failed change never leaves a success event.

## 12. Web UI

Route: `/workspaces/{w}/projects/{p}/environments/{e}`. The environment frame shows the
breadcrumbs, name, protection status and environment switcher; the page shows the variables.

- **Table:** a selection checkbox, Key (with description, tags and a Required badge), Value,
  Type (with the current version, for example `v2`), Category, Updated, Actions. Values are
  masked as `••••••••••••` (fixed length, so the length is not disclosed).
- **Search, filters, sort and pagination** live in the URL; the server fetches one page of
  metadata (50 rows). Mutations revalidate only the environment page.
- **Reveal:** the value stays in the row's state for 30 seconds and is cleared when hidden,
  when the tab is hidden and when the row unmounts. In protected environments the first reveal
  asks for the password. Copy is available only while a value is revealed.
- **Add and edit dialog:** as in Phase 3B, plus the change note stored with a new value and
  the **Inheritable** switch (disabled for `SECRET`, see
  [configuration-inheritance.md](configuration-inheritance.md)).
- **Inherited variables** (environments with a base): listed below the table with their source
  and an Override action; local variables that override one carry an **Overrides** badge.
- **Import wizard:** paste or choose a file (shown masked by default), review entries with
  statuses and per entry Create, Overwrite or Skip, then a progress state and a summary.
  Cancel at any point before importing leaves everything unchanged.
- **Export dialog:** environment, format, all or the selected variables, a protected
  environment warning, and an acknowledgement checkbox before Download.
- **History drawer** (row menu, History): the version timeline, reveal of old values, compare
  two versions (and an optional line diff), and Restore with a confirmation and optional note.
- **Bulk bar** (after selecting rows): Select all matching, Edit details (category, tags,
  required), Export, Delete with typed confirmation, Restore in the Deleted view, Clear.
- Controls follow the caller's permissions (the API decides regardless). Archived
  environments are read only.

**Browser memory.** Drafts, import content, revealed values and export content are never
written to `localStorage`, `sessionStorage`, IndexedDB, cookies or the URL. They exist in React
state and in server action responses while needed. JavaScript strings cannot be wiped, so a
value can stay in the heap until garbage collection; downloaded files and the clipboard are
outside EnvVault's control.

## 13. Testing locally, and what Neon still needs

Everything above was built and tested with **disposable local PostgreSQL and synthetic
values only**: unit tests, database and API integration tests (including the migration
safety test on representative legacy data) and Playwright against the development keyring.

Manual check, synthetic values only:

1. `pnpm crypto:init:dev`, add the two printed lines to `.env`, then `pnpm dev`.
2. Open a project's **Development** environment and **Import** a pasted file with a few
   made up values, a quoted multiline value and an invalid line. Review, import.
3. Edit one value twice, open **History**, reveal v1, compare v1 and v3, restore v1.
4. Select all, **Edit details** to set a category; **Export** as `.env` and import the file
   into another environment; the values match.
5. As a Developer, check that Export and Restore are not offered and that the API refuses
   them. As Project Admin, check that Production needs a Secret writer or Secret exporter grant.
6. Reveal one variable more than 20 times in a minute: the API answers 429.
7. Bulk delete with the typed confirmation, then restore from **Deleted**.
8. Check **Activity** and `audit_events` for the events in section 11, and that
   `secret_versions` holds only ciphertext.

**Neon Develop status.** `20261021090000_secrets_crud` and
`20261022090000_secret_version_history` were applied to the Develop branch with approval, and
the catalog was synced. Still owed there, each only after explicit approval:

- `20261023090000_environment_intelligence` (Phase 3D) and
  `20261024090000_security_hardening` (Phase 3E), in that order, with `pnpm db:migrate:deploy`.
  Neither adds permissions, so no catalog sync is needed.
- Run `pnpm db:check-drift` and the integration suites against a Develop branch copy.
- Measure the import of 500 variables and a 1000 variable export over Neon's latency (the
  transactions allow 60 seconds and use one statement per batch).
- Confirm that `audit_events` stays under the metadata limit for the largest batches.
