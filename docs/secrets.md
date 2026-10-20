# Secrets and environment variables

An environment holds **variables**: a name, metadata and an encrypted value with a version
history. This document covers the lifecycle, types, API, authorization and UI. The
cryptography is in [encryption.md](encryption.md), key storage in
[key-management.md](key-management.md).

> **Status (Phase 3B).** Variables are stored in PostgreSQL and every value goes through the
> Phase 3A envelope encryption. Keys come from the **self managed development keyring**,
> which is not a production key store. Use synthetic values only until a managed KMS
> provider is in place and reviewed.

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

**Integrity rules in the database:** names must match `^[A-Za-z_][A-Za-z0-9_]*$`; a partial
unique index (`secrets_environment_key_live_key`) makes names unique per environment among
live rows, so the same name can exist in other environments and a deleted name can be reused;
the current version must belong to the same secret (composite foreign key); version numbers
are unique per secret; tags are capped at 20; categories are trimmed.

**Retention (first implementation):** every encrypted version is kept, including after a soft
delete. Nothing is purged yet; purge and retention policies come with later hardening work.
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
including errors, carries `Cache-Control: no-store, max-age=0`.

| Method and path      | Permission      | Notes                                                              |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `GET /`              | `secret:list`   | Metadata page; never decrypts. Filters below                       |
| `POST /`             | `secret:write`  | `{ key, value?, type, description?, category?, tags, isRequired }` |
| `GET /{id}`          | `secret:list`   | Metadata                                                           |
| `PATCH /{id}`        | `secret:write`  | `{ expectedRevision, …changes, value? }`                           |
| `DELETE /{id}`       | `secret:delete` | Soft delete; optional `?expectedRevision=`                         |
| `POST /{id}/restore` | `secret:delete` | 409 when the name is taken                                         |
| `POST /{id}/reveal`  | `secret:read`   | Current value; audited; protected environments need a step up      |
| `GET /{id}/versions` | `secret:list`   | Version numbers, dates and authors only                            |

List query: `page`, `pageSize` (at most 100), `q` (name or description, case insensitive),
`type=SECRET,JSON`, `category=Database,none` (`none` means uncategorised), `tag`,
`status=active|deleted`, `sort=name|type|category|created|updated`, `order=asc|desc`. The
response adds `facets` (categories and tags in use) for the filters.

Errors: `SECRET_KEY_TAKEN`, `SECRET_CONFLICT`, `SECRET_NOT_DELETED`, `SECRET_VALUE_NOT_SET`,
`SECRET_VALUE_REQUIRED`, `ENCRYPTION_UNAVAILABLE` (503: keys not configured or the key
version is missing), `SECRET_INTEGRITY_ERROR` (500: the stored value failed authentication),
plus the usual `NOT_FOUND`, `FORBIDDEN`, `STEP_UP_REQUIRED`. Crypto details never reach
clients.

The SDK exposes `listSecrets`, `createSecret`, `getSecret`, `updateSecret`, `deleteSecret`,
`restoreSecret`, `revealSecret` and `listSecretVersions`. The routes are in the OpenAPI
document at `/api/v1/openapi.json`.

## 5. Authorization

The catalog keeps its Phase 2 names. Mapping to the capabilities of this phase:

| Capability     | Permission                                    |
| -------------- | --------------------------------------------- |
| Read metadata  | `secret:list`                                 |
| Read values    | `secret:read`                                 |
| Create, update | `secret:write`                                |
| Delete         | `secret:delete`                               |
| Restore        | `secret:delete` (restoring undoes a deletion) |

Every secret route requires `secret:list` in the environment through the global guard, which
loads the caller's membership, project role and grants from the database on each request.
The data plane permissions are then checked by `SecretAuthorizationService`, which records a
`secret.access_denied` audit event for each refusal.

- **Workspace roles never grant secret permissions.** An Owner or Admin who administers a
  project through the workspace role cannot list or reveal its variables.
- **Protected environments never inherit** `secret:read`, `secret:write` or `secret:delete`,
  not even from Project Admin. They come only from an explicit ALLOW grant on that
  environment (for example the Secret reader or Secret writer role).
- **Reveals in protected environments also need a recent step up** (password confirmation,
  `POST /auth/step-up`, valid for `AUTH_STEP_UP_TTL_SECONDS`, 10 minutes by default).
- DENY grants override ALLOW; expired grants are ignored; removing a project member or a
  workspace member takes effect on the next request.
- Every lookup is scoped by workspace, project and environment together: an id from another
  tenant, project or environment is `404`, like a missing variable.

## 6. Audit events

Written to `audit_events` with the actor, the workspace, project and environment, the secret
id and the request id. Metadata holds names, version numbers and error categories, never
values or request bodies.

| Action                                                 | Outcome | Written                                                                                                                 |
| ------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `secret.created`                                       | SUCCESS | In the creating transaction                                                                                             |
| `secret.updated`                                       | SUCCESS | In the transaction; lists changed fields and renames                                                                    |
| `secret.value_changed`                                 | SUCCESS | In the transaction; new version number                                                                                  |
| `secret.deleted`, `secret.restored`                    | SUCCESS | In the transaction                                                                                                      |
| `secret.revealed`                                      | SUCCESS | After decryption, before the value is returned. If it cannot be written the value is withheld (`503 AUDIT_UNAVAILABLE`) |
| `secret.access_denied`                                 | DENIED  | When a permission or step up check refuses                                                                              |
| `secret.encryption_failed`, `secret.decryption_failed` | FAILURE | With the crypto error code only                                                                                         |

Because mutation events share the transaction, a failed change never leaves a success event.
Project activity shows these events with the variable name.

## 7. Web UI

Route: `/workspaces/{w}/projects/{p}/environments/{e}`. The environment frame shows the
breadcrumbs, name, protection status and environment switcher; the page shows the variables.

- **Table:** Key (with description, tags and a Required badge), Value, Type (with the current
  version, for example `v2`), Category, Updated, Actions. Values are masked as
  `••••••••••••` (fixed length, so the length is not disclosed).
- **Search, filters, sort and pagination** live in the URL; the server fetches one page of
  metadata (50 rows) from the API. Search is debounced. Mutations revalidate only the
  environment page.
- **Reveal:** the eye button calls a server action that calls the API. The value stays in the
  row's component state for 30 seconds and is cleared when hidden, when the tab is hidden,
  and when the row unmounts (another page, filter or environment). In protected
  environments the first reveal asks for the password. Copy is available only while a value
  is revealed and warns that the clipboard is outside EnvVault.
- **Add and edit dialog:** name, type, value (hidden by default, JSON formatting, multiline
  editor), description, category (suggestions plus your own), tags and Required. Editing never
  shows the current value; replacing it is an explicit switch. A concurrent change shows a
  conflict with a Reload button instead of overwriting.
- **Delete** asks for confirmation; the **Deleted** view lists deleted variables with Restore.
- Controls follow the caller's permissions (the API decides regardless). Archived
  environments are read only.
- Expected keys from the environment template that have no variable yet are offered as
  one click Add buttons.

**Browser memory.** Drafts and revealed values are never written to `localStorage`,
`sessionStorage`, IndexedDB, cookies or the URL. They exist in React state and in the server
action response while needed. JavaScript strings cannot be wiped, so a value can stay in
the JavaScript heap until garbage collection, and the browser, extensions and the operating
system clipboard are outside EnvVault's control.

## 8. Manual testing

Use synthetic values only.

1. `pnpm crypto:init:dev`, add the two printed lines to `.env`, then `pnpm dev`.
2. Sign in, open a project, open **Development**.
3. **Add variable** `SYNTHETIC_TOKEN` with a made up value. The row shows the mask and `v1`.
4. Reveal it; it hides again after 30 seconds or when you click the eye.
5. Edit it, switch on **Replace the value**, save: the row shows `v2`.
6. Open the same variable in two tabs, edit in both: the second save shows the conflict.
7. Add a member as **Viewer**: they see names and metadata, no eye button.
8. Open **Production** as Project Admin: no Add button and no reveal until an admin grants you
   **Secret writer** on Production; then the first reveal asks for your password.
9. Delete the variable, open **Deleted**, restore it. Create another variable with the same
   name first to see the restore conflict.
10. Check **Activity** for the created, changed, revealed, deleted and restored events.
11. In the database, `SELECT * FROM secret_versions` shows only ciphertext.
