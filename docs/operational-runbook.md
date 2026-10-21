# Operational runbook

Operator procedures for a production EnvVault. Every command below is `pnpm ops <command>`
(the API's operator tool), run on the API host or in a one off container with the key
directory mounted **read write**. Commands print the target database host and name first;
check it before continuing. They never print key material, recovery keys or values.

Related: [disaster-recovery.md](disaster-recovery.md), [key-management.md](key-management.md),
[deployment.md](deployment.md), [security-hardening.md](security-hardening.md).

## 1. Initial key setup

```bash
pnpm ops keys:init --out /srv/envvault/keys/keyring.json               # usage self-managed by default
pnpm ops integrity:init-key --out /srv/envvault/keys/integrity.json
pnpm ops keyring:recovery-key --out /media/offline/recovery-key.json   # move offline now
pnpm ops keyring:backup --keyring-file /srv/envvault/keys/keyring.json \
  --recovery-key-file /media/offline/recovery-key.json --out /backups/keyring-$(date +%F).json
chown 10001:10001 /srv/envvault/keys/*.json && chmod 0400 /srv/envvault/keys/*.json
```

Store the recovery key and the backups in different places. Test the backup right away
(section 4).

## 2. Key rotation

Rotate on a schedule (for example yearly), after staff changes, and at once if the keyring may
be exposed.

1. `pnpm ops keys:status`: current versions and how many secret versions use each.
2. `pnpm ops keys:rotate --confirm <key id>`: adds version n+1 as active; n becomes
   `decrypt-only`. The file is written atomically before anything uses the new key.
3. `pnpm ops keyring:backup ...`: back up the rotated keyring.
4. Restart every API instance so new values use version n+1.
5. `pnpm ops keys:rewrap --dry-run`: how many data keys would move.
6. `pnpm ops keys:rewrap`: moves data keys onto the active version, one compare and set update
   per row (only the wrapped key and key version change; ciphertext never does). Ctrl+C stops
   after the current row; running it again continues. Failures are listed by version id and
   error category.
7. `pnpm ops keys:verify --key-version <n+1>`: authenticates the moved envelopes.
8. Optional, later: `pnpm ops keys:retire --version <n> --backup <file> --recovery-key-file <file> --confirm <key id>`.
   It refuses while any row or change request uses version n, and unless the backup holds the
   same material for version n. Keep that backup as long as database backups from before the
   rewrap exist.

Events recorded: `encryption.key_rotated`, `encryption.rewrap_started`,
`encryption.rewrap_completed` or `encryption.rewrap_interrupted`, `encryption.key_retired`,
`encryption.keyring_backed_up`.

## 3. Integrity key rotation

`pnpm ops integrity:rotate-key --confirm <active key id>`, back up the file, restart the API.
Old keys stay in the file to verify old seals.

## 4. Backup verification

Monthly, and after every backup:

```bash
pnpm ops keyring:verify-backup --backup <file> --recovery-key-file <file> --against-database
```

It opens the backup, checks its integrity and reports whether every key version the database
references is covered.

## 5. Audit verification

Daily, for example from cron:

```bash
pnpm ops audit:verify --expect-head <chain:seq:mac> ...
```

Copy the heads it prints to a place the database cannot reach (a ticket, a log service, a
signed message) and pass the previous day's heads with `--expect-head`. A `PROBLEM` line means
sealed history changed: treat it as an incident (section 8). `pnpm ops audit:seal --full`
seals events older than the regular window if sealing was off.

## 6. Retention

1. A workspace Owner or Admin sets the policy: `PUT /api/v1/workspaces/{id}/retention`
   (deleted variable days, versions to keep and minimum age, snapshot days, audit days of at
   least 90, whether protected environments are included; including them needs a step up).
2. `POST .../retention/preview` counts what would go.
3. An Owner starts a run with a recent step up and the workspace slug typed as confirmation:
   `POST .../retention/runs`. The background worker purges in batches of 200 per transaction;
   `GET .../retention/runs/{id}` shows progress.
4. Never purged: variables or versions a snapshot references, variables in open change
   requests, current versions, versions a later version was restored from, and protected
   environments unless included. Audit events go only as a prefix of their sealed chain, with a
   checkpoint.

Purging is **logical deletion**: Neon keeps earlier states in its history and backups for its
own retention period, and EnvVault cannot erase those. It is not cryptographic erasure.

## 7. Restoring from backup

Follow [disaster-recovery.md, section 4](disaster-recovery.md#4-recovery-procedure-summary).
Never restore over a damaged database or keyring; restore next to it and switch over after
verification.

## 8. Incident response

| Signal                                                | First steps                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Suspected keyring exposure                            | Block access to the host, rotate keys, rewrap, retire the exposed versions once nothing uses them, rotate the affected real secrets at their sources, review `secret.*` audit events |
| Suspected account takeover                            | Revoke the user's sessions (sign out everywhere), remove grants, review their audit events, rotate secrets they could read                                                           |
| `audit:verify` PROBLEM                                | Preserve the database (dump) and logs, compare with the last recorded heads, find who had owner rights, do not purge anything                                                        |
| Many `security.rate_limited` or `authz.denied` events | Identify the user and source, suspend the account if hostile                                                                                                                         |
| `RATE_LIMIT_UNAVAILABLE` errors                       | Redis is down; sensitive actions are refused by design; restore Redis                                                                                                                |
| Readiness reports encryption down                     | Keyring missing or unreadable; restore it from backup (section 7)                                                                                                                    |

Record every incident, the actions taken and the times. Real customer notification duties
depend on your jurisdiction and contracts.

## 9. Pending database changes

Not yet applied to Neon Develop; each needs explicit approval first:

| Migration                                 | Phase | Content                                                        |
| ----------------------------------------- | ----- | -------------------------------------------------------------- |
| `20261023090000_environment_intelligence` | 3D    | Inheritance, validation rules, snapshots                       |
| `20261024090000_security_hardening`       | 3E    | Audit seals, retention, maintenance jobs, idempotency, indexes |

Neither adds permissions, so no catalog sync is needed. Apply in order with
`pnpm db:migrate:deploy` (`DIRECT_URL` pointing at the branch), then `pnpm db:check-drift`.

### Migration review

Both migrations were reviewed for Phase 3E and tested on a disposable copy holding Phase 3C
data (`packages/database/test/integration/migration-safety.test.ts`): each is atomic (a
failure on its last statement leaves the schema unchanged), every existing row and byte
survives, and the new constraints accept existing data.

| Check                  | `20261023090000_environment_intelligence`                                                                                                                  | `20261024090000_security_hardening`                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destructive statements | None on data. Drops and recreates one CHECK (`secret_versions_rollback_source_chk`) to also allow `RESTORE`; it is validated against existing rows         | None on data. Replaces the audit trigger function so a delete is allowed only inside a transaction that sets `envvault.retention_purge`                                               |
| Data rewritten         | None. New columns are nullable or have a constant default (no table rewrite)                                                                               | None                                                                                                                                                                                  |
| Transaction            | `BEGIN` ... `COMMIT`; `ALTER TYPE ... ADD VALUE` runs inside it (PostgreSQL 12 or later) and the new value is not used in the same transaction             | `BEGIN` ... `COMMIT`                                                                                                                                                                  |
| Foreign keys           | New tables only, plus a self reference on `environments` whose new column is all null                                                                      | `audit_seals` to `audit_events` (no action), so a plain `TRUNCATE audit_events` is also refused; new tables cascade from `workspaces`                                                 |
| Indexes                | Built without `CONCURRENTLY`, so writes to those tables wait while they build; a unique `secrets(environment_id, id)` always holds because `id` is the key | Same; four new indexes on existing tables (one partial), plus those of the new tables. `secret_versions(encryption_key_id)` is now a prefix of a new index and could be dropped later |
| Locks                  | Short `ACCESS EXCLUSIVE` locks on `secrets`, `secret_versions` and `environments`                                                                          | Short locks on `audit_events`, `secret_versions`, `secrets`, `environment_snapshots`                                                                                                  |

Locks and index builds take milliseconds at the current sizes. On large tables, build the
indexes with `CREATE INDEX CONCURRENTLY` beforehand (outside a transaction) and make the
migration's statements no ops.

The trigger change is a small loosening on its own: a session with SQL access as the
application role can set the setting and delete audit rows. That role owns the tables and
could already disable the trigger, and the audit seals are what detect either.

**Rolling back.** Restore the Neon branch to a point in time just before the migration (take
that point, or a dump, first), and redeploy the previous release; both releases' code depends
on its schema. A manual reversal is possible but loses data:

1. Security hardening: drop `audit_seal_checkpoints`, `audit_seals`, `idempotency_records`,
   `maintenance_jobs` and `retention_policies` (seals, policies and job history are lost),
   drop the four new indexes on existing tables, restore the trigger function from
   `20261012124700_integrity_constraints`, and delete the migration's row from
   `_prisma_migrations`.
2. Environment intelligence: PostgreSQL cannot drop an enum value, so `RESTORE` stays unless
   the type is rebuilt, and versions with that origin would need a decision first. Dropping
   the snapshot and rule tables and the inheritance columns loses snapshots, rules and base
   settings. Prefer the point in time restore.
