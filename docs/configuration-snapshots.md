# Configuration snapshots, drift and restore

A snapshot records the state of an environment at one moment: every live variable's name,
metadata and the id of its current value version. It holds no plaintext, no ciphertext and no
value derived data. The values stay in the encrypted version history, which is never rewritten.

Code: `apps/api/src/intelligence/snapshot.service.ts`, repository
`packages/database/src/repositories/intelligence.repository.ts`, tables `environment_snapshots`
and `environment_snapshot_entries`.

## 1. Capture

`POST .../environments/{e}/snapshots` with an optional description (500 characters).

1. Needs `secret:write` on the environment (and the environment must be active).
2. Captured in one `REPEATABLE READ` transaction, so the entries are consistent with each other.
3. Entries reference `secrets(environment_id, id)` and `secret_versions(secret_id, id)` with
   composite foreign keys, so an entry can only point at a version of its own variable in its own
   environment.
4. Snapshots and entries are immutable (update triggers reject changes).
5. Audited as `environment.snapshot_created`.

## 2. Drift

`POST .../snapshots/{s}/diff` compares a snapshot with the current state, or with another
snapshot of the same environment (`againstSnapshotId`). Variables are matched by id, so a
rename is reported as a change of `key`, not as a removal plus an addition.

Each row reports `added`, `removed`, `modified` or `unchanged`, the metadata fields that
changed, and `versionChanged`. **A different version does not mean a different value**: a value
can be set again to the same text, and a rollback creates a new version with old content.
Without `compareValues` the UI says _Different version (value not compared)_.

With `compareValues: true` the server decrypts both referenced versions and reports `equal`,
`different` or `not_comparable`, under the same rules as environment comparison: `secret:read`,
step up when protected, `bulk-read` rate limit, audit `environment.snapshot_values_compared`.

## 3. Restore

Restore is two calls: a preview and the restore itself.

`POST .../snapshots/{s}/restore/preview` with `{ "removeAdded": true }` returns:

1. `actions`: per variable `update`, `undelete`, `delete` or `unchanged`, the fields that
   change, and whether a value is restored.
2. `conflicts` (blocking): a name that another live variable holds, or a variable that no
   longer exists.
3. `warnings` (not blocking): what cannot be restored exactly, for example a variable that had
   no value in the snapshot keeps its current value, because values are never removed.
4. `expectedState`: the ids and revisions the preview was built from.

`POST .../snapshots/{s}/restore` with `{ "expectedState": [...], "removeAdded": true,
"changeReason": "..." }`:

1. Needs `secret:write` and `secret:rollback`, plus `secret:delete` when the plan deletes or
   undeletes, plus a recent step up when the environment is protected.
2. Rebuilds the plan and refuses with `SNAPSHOT_STALE` (409) if the live state differs from
   `expectedState`, and with `SNAPSHOT_RESTORE_BLOCKED` while conflicts exist.
3. Decrypts every snapshot version that will be restored and encrypts it again with the active
   key, all before the transaction starts. If a key is missing or decryption fails, nothing is
   written (`environment.snapshot_restore_failed` is audited without the value).
4. Applies everything in one transaction: metadata updates, undeletes, deletes of variables
   created after the snapshot (when `removeAdded`), and a **new version** for each restored
   value with origin `RESTORE` and `restored_from_version_id` pointing at the snapshot version.
   Every variable's revision is checked again inside the transaction.
5. Audited as `environment.snapshot_restore_started` and `environment.snapshot_restored` with
   counts, plus the per variable events in batches.

Because a restore only adds versions, it can itself be undone by restoring another snapshot or
rolling back single variables.

## 4. API summary

| Route                                    | Permission                                                      |
| ---------------------------------------- | --------------------------------------------------------------- |
| `GET .../snapshots`                      | `secret:list`                                                   |
| `POST .../snapshots`                     | `secret:write`                                                  |
| `GET .../snapshots/{s}`                  | `secret:list`                                                   |
| `POST .../snapshots/{s}/diff`            | `secret:list` (+ `secret:read` and step up to compare values)   |
| `POST .../snapshots/{s}/restore/preview` | `secret:list`                                                   |
| `POST .../snapshots/{s}/restore`         | `secret:write` + `secret:rollback` (+ `secret:delete`, step up) |

SDK: `listSnapshots`, `createSnapshot`, `getSnapshot`, `snapshotDiff`,
`previewSnapshotRestore`, `restoreSnapshot`.

## 5. Web

1. **Snapshots** tab: list, **Take snapshot** with a description.
2. Snapshot page: recorded variables with version numbers, the drift report against the current
   state or another snapshot, **Compare values** (with `secret:read`), and **Restore**, which
   opens the preview with conflicts, warnings and the planned changes before anything is written.

## 6. Limitations

1. Snapshots are manual; there are no scheduled snapshots or retention rules yet.
2. Inherited variables are not captured; a snapshot records the environment's own variables.
3. A variable that had no value in the snapshot cannot be returned to having no value.
