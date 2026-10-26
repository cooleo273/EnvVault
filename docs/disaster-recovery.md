# Disaster recovery

EnvVault needs **two independent things** to recover: the database (ciphertext, history,
audit) and the keyring (the keys that decrypt it). A database backup without the keyring is
unreadable; a keyring without the database has nothing to decrypt. Database backups alone are
never enough.

Procedures are in [operational-runbook.md](operational-runbook.md). Key handling is in
[key-management.md](key-management.md).

## 1. Objectives

Design targets for a small deployment, **not guarantees**:

| Objective             | Target              | Depends on                                                    |
| --------------------- | ------------------- | ------------------------------------------------------------- |
| Recovery point (data) | 5 minutes           | Neon point in time restore; seconds of commits can be lost    |
| Recovery point (keys) | Last keyring backup | A backup after every rotation                                 |
| Recovery time         | 2 hours             | Operator availability, recovery key access, Neon restore time |

## 2. What to back up

| Item          | How                                                                   | Where                                                                                       | Frequency                               |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| PostgreSQL    | Neon point in time restore, plus a periodic `pg_dump --format=custom` | Neon, and a separate encrypted store for dumps                                              | Continuous, dumps daily                 |
| Keyring       | `pnpm ops keyring:backup` (encrypted under the recovery key)          | At least two locations apart from the host                                                  | After creation and after every rotation |
| Recovery key  | `pnpm ops keyring:recovery-key` once                                  | Offline (password manager, encrypted drive, printed copy in a safe), never with the backups | Once; replace if exposed                |
| Integrity key | Copy of `INTEGRITY_KEY_FILE`                                          | With the keyring backups                                                                    | After creation and rotation             |
| Configuration | Environment files                                                     | Platform secret store                                                                       | On change                               |

The tooling never copies keys to cloud storage on its own. Where backups go is an operator
decision.

## 3. Key loss scenarios

| Scenario                                                         | Effect                                                               | Recovery                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Keyring file deleted or corrupted, backup available              | Values unreadable, API refuses to start                              | Restore the backup, verify, restart                                                                                            |
| Keyring and every backup lost                                    | **All values permanently unrecoverable**                             | None. Recreate secrets from their sources                                                                                      |
| Recovery key lost, keyring intact                                | Backups cannot be opened                                             | Create a new recovery key and new backups immediately                                                                          |
| Recovery key exposed                                             | Backups can be opened by whoever has it                              | New recovery key, new backups, destroy old backups, consider key rotation                                                      |
| Keyring exposed                                                  | Every value in the database and its backups is at risk               | Rotate, rewrap, retire old versions after the rewrap, rotate the actual secrets                                                |
| Old key version retired, then an old database backup is restored | Rows rewrapped after that backup still reference the retired version | Restore the keyring backup taken before retirement; `keys:retire` requires one                                                 |
| Integrity key lost                                               | Existing seals cannot be verified; events stay readable              | New key (`integrity:init-key`); new seals extend the chains, older seals report `unknown_key`; record the loss in the incident |

## 4. Recovery procedure (summary)

1. Restore the database into a **new** Neon branch or database, never over the damaged one.
2. Restore the keyring backup into an isolated directory with
   `pnpm ops keyring:restore --to <new path>` (it never replaces an existing keyring without
   `--overwrite <key id>`).
3. Verify before serving traffic:
   `pnpm ops keyring:verify-backup --against-database`, `pnpm ops keys:verify`,
   `pnpm ops audit:verify --expect-head ...`, `pnpm db:migrate:status`.
4. Point the API at the restored database and keyring and start it.

## 5. Verification drill

`pnpm --filter @envvault/api drill` runs the whole cycle on disposable local databases with
synthetic data: seed values with history, a snapshot and sealed audit events; back up the
keyring and dump the database; delete the keyring; restore both into a separate database and
path; verify. Last local run (PostgreSQL 18, 51 versions; milliseconds):

| Step                                           | Time |
| ---------------------------------------------- | ---- |
| Keyring backup (sealed and verified)           | 11   |
| `pg_dump`                                      | 243  |
| `pg_restore` into a new database               | 249  |
| Keyring restore                                | 11   |
| Authenticate every envelope                    | 15   |
| Verify audit chain (head matches the original) | 12   |

The drill also checks that migrations are up to date on the restored copy, that every
current version belongs to its variable, that version numbers are consistent, and that every
snapshot entry still has its version. It was **not** run against Neon; a Neon restore has to
be rehearsed on a non production branch.

## 6. Schema migration recovery

Migrations run as a separate release step and each is one transaction (`BEGIN` ... `COMMIT`),
so a failed migration leaves the schema as it was. If a deployed migration must be undone,
restore the branch from the point in time just before it rather than writing a down
migration by hand, then redeploy the previous release. Take a dump before applying a reviewed
migration to Neon.
