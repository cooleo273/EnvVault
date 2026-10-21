# Key management

Key encryption keys (KEKs) are held by a **key provider**. Business code depends only on
the `KeyManagementProvider` interface (`packages/crypto/src/provider.ts`), so a managed
KMS can replace the local provider without changing callers.

> **The local provider keeps keys on the API host.** Its master keys live in a file (or, in
> development, an environment variable) and in the API process's memory. That is **not**
> equivalent to a managed or hardware backed KMS (AWS KMS, Google Cloud KMS, Azure Key Vault,
> HashiCorp Vault Transit): there is no HSM, no access policy, no independent audit trail of
> key use, and anyone who can read the file or the process's memory has the keys.
> Development keyrings are refused in production; production accepts only an explicitly
> acknowledged self managed keyring (section 7).

## 1. Provider interface

| Operation                     | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `validateKeyConfiguration()`  | Checks keys are present and well formed; self-tests every usable version |
| `getActiveKeyVersion()`       | Key id and version that wrap new DEKs                                    |
| `listKeyMetadata()`           | Id, version, status and creation time of every version. Never material   |
| `generateDataKey(context)`    | Fresh random DEK plus its wrapped form under the active KEK              |
| `wrapDataKey(dek, context)`   | Wraps an existing DEK under the active KEK (re-wrapping)                 |
| `unwrapDataKey(wrapped, ctx)` | Unwraps with exactly the referenced version; fails closed                |
| `rotateWrappingKey()`         | Administrative: new active version, older ones become decrypt-only       |

No operation returns a KEK. Plaintext DEKs are `DataKey` objects that render as
`[DataKey]` in logs and JSON, and are zeroed on `destroy()`. The package exports a
`browser` build that throws on import, and providers refuse to start where a `window`
exists, so it cannot be bundled into the web client.

## 2. Local keyring

```json
{
  "format": "envvault.local-keyring",
  "formatVersion": 1,
  "usage": "development",
  "keyId": "local-<32 hex>",
  "activeVersion": 2,
  "versions": [
    { "version": 1, "status": "decrypt-only", "createdAt": "…", "key": "<base64, 32 bytes>" },
    { "version": 2, "status": "active", "createdAt": "…", "key": "<base64, 32 bytes>" }
  ]
}
```

Rules enforced when loading. Each violation is a `KeyConfigurationError` that never
echoes the value.

- Every key is exactly **256 bits** of canonical base64. Constant bytes (e.g. all zeros)
  are rejected as placeholders.
- There is exactly one `active` version, and it is the newest. Version numbers are
  unique, and versions never share material.
- `retired` versions hold no material.
- Keys come only from `crypto.randomBytes`. They are never hardcoded, derived from a
  password or string, or created implicitly.

### Where keys live

| Source                                    | Configuration                                   | Rotation                 |
| ----------------------------------------- | ----------------------------------------------- | ------------------------ |
| File (recommended for development)        | `ENCRYPTION_KEYRING_FILE=<absolute path>`       | `pnpm crypto:rotate:dev` |
| Environment variable (server-side secret) | `ENCRYPTION_LOCAL_KEYRING=<base64 of the JSON>` | Not supported in place   |

Rules for both sources:

- Keys are **never** stored in Neon or PostgreSQL. The database stores only key ids and
  versions.
- Keys never go in Git: `.envvault/` is gitignored, as is every `.env*` except the
  example.
- Never use a `NEXT_PUBLIC_*` variable. The web app has no access to keys.

### File protection by platform

| Platform      | What `crypto:init:dev` does                                                                    | What you must check                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Linux / macOS | Directory `0700`, file `0600`, atomic write. The API refuses files readable by group or others | Keep the repository on a disk only you can read; enable FileVault or LUKS                 |
| Windows       | POSIX modes do not apply. The file inherits the NTFS ACL of its folder                         | Keep the repository inside your user profile; enable BitLocker; do not use shared folders |

The CLI refuses paths inside web-served directories (`public`, `.next`, `static`, `www`)
and `NODE_ENV=production`. The API never creates keys at start-up.

## 3. Developer setup

```bash
pnpm crypto:init:dev               # creates .envvault/dev-keyring.json (never prints the key)
# then add the two lines it prints to .env:
#   ENCRYPTION_PROVIDER=local
#   ENCRYPTION_KEYRING_FILE=/absolute/path/to/.envvault/dev-keyring.json
pnpm crypto:status:dev             # versions and statuses only
```

- **Running `init` again refuses** to overwrite. Replacing a keyring destroys its keys,
  so it requires `--overwrite <current key id>`.
- **Back up the keyring file** to protected storage, such as a password manager or an
  encrypted volume. **If it is lost, every secret encrypted with it is permanently
  unrecoverable.** There is no escrow and no recovery key.
- Without `ENCRYPTION_PROVIDER=local`, encryption is **disabled**. The API starts, and
  every encryption call fails with `NOT_CONFIGURED`. A configured but unusable keyring
  stops start-up with `Invalid encryption configuration: …`, distinct from other
  start-up errors.

## 4. Rotation, rewrapping and retirement

Development keyrings rotate with `pnpm crypto:rotate:dev`. The operator tool `pnpm ops`
(Phase 3E) handles the whole lifecycle against the database and works for both keyring
usages; [operational-runbook.md, section 2](operational-runbook.md#2-key-rotation) has the
procedure.

| Command                                                                                 | What it does                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `keys:status`                                                                           | Key versions, how many secret versions reference each, versions that can be retired, data the keyring cannot decrypt               |
| `keys:rotate --confirm <key id>`                                                        | Adds version n+1 as `active`; n becomes `decrypt-only`. Written atomically (temporary file, fsync, rename) before anything uses it |
| `keys:rewrap [--dry-run]`                                                               | Moves data keys still on older versions onto the active one                                                                        |
| `keys:verify [--key-version n]`                                                         | Authenticates stored envelopes without producing values                                                                            |
| `keys:retire --version n --backup <file> --recovery-key-file <file> --confirm <key id>` | Destroys the material of an unreferenced `decrypt-only` version                                                                    |

**Rewrap.** Each row is unwrapped with its own version, checked against its ciphertext with the
same context, wrapped under the active version and stored with a compare and set update
(`id`, old key version and old wrapped key must still match). Only `encrypted_data_key`,
`kms_key_version` and `rewrapped_at` change; the immutability trigger keeps every other column,
including the ciphertext, unchanged. A crash leaves each row old or new, never half written;
a rerun continues where the last one stopped (rows on the active version are skipped).
`--dry-run` reports counts only. Runs are recorded as `encryption.rewrap_started` and
`encryption.rewrap_completed` or `encryption.rewrap_interrupted`, with counts and the ids of
failed rows.

**Retirement** refuses the active version, any version still referenced by a secret version,
any retirement while change request values (envelopes without a recorded key version) exist,
and any retirement without a backup that opens with the recovery key and holds the same
material for that version. That backup is what restores database backups taken before the
rewrap. Old versions are never deleted silently.

## 5. Moving to a managed KMS

Implement `KeyManagementProvider` for the KMS:

- `generateDataKey` maps to the KMS's GenerateDataKey with an encryption context, and
  `unwrapDataKey` maps to Decrypt.
- `rotateWrappingKey` maps to the KMS's key rotation.

Then extend `ENCRYPTION_PROVIDER` and `loadEncryption()`. Envelopes record `providerId`,
`keyId` and `keyVersion`, so data encrypted under the local provider can be migrated by
re-wrapping each DEK: unwrap with the local provider, wrap with the KMS. A production
deployment needs that reviewed provider. The local provider must not be used.

## 6. Keyring backup and recovery

A keyring backup is the keyring encrypted with AES-256-GCM under a subkey derived (HKDF-SHA256,
random salt per backup) from a **recovery key**: 256 random bits created by
`pnpm ops keyring:recovery-key`, stored offline and never with the backups, the keyring, Git
or the database.

| Command                                                                                 | What it does                                                                             |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `keyring:recovery-key --out <file>`                                                     | New recovery key file (mode 0600, never overwrites); prints its id only                  |
| `keyring:backup --recovery-key-file <file> --out <file>`                                | New versioned backup (id, time, key id, versions), opened again before it is written     |
| `keyring:verify-backup --backup <file> --recovery-key-file <file> [--against-database]` | Integrity check, and coverage of every key version the database uses                     |
| `keyring:restore --backup <file> --recovery-key-file <file> --to <file>`                | Restores into a new file; replacing an existing keyring needs `--overwrite <its key id>` |

The readable header (key id, usage, versions, recovery key id, salt) is authenticated as
associated data: editing it, the ciphertext or the tag makes the restore fail. A wrong
recovery key fails the same way. Plaintext keyrings are never exported. Scenarios and the
drill are in [disaster-recovery.md](disaster-recovery.md).

## 7. Self managed keys in production

`pnpm ops keys:init --usage self-managed --out <file>` creates a keyring with usage
`self-managed`. The API accepts it only when `NODE_ENV=production`,
`ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED=true` and it is loaded from a file (an inline keyring is
refused in production). Outside production a self managed keyring is refused, so production
keys are not used on developer machines by accident.

What this deployment mode does **not** protect against: compromise of the API host or
process (the keys are in the same place as the code that uses them), an operator with access
to the key file, loss of the keyring together with every backup, and the absence of an
independent record of key use. It exists so a small installation can run; the target is a
managed KMS provider (section 5).

`ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED` is **false by default** and is a configuration switch,
not evidence that a deployment is safe: setting it records that the operator accepts the
risks above, nothing more. Before setting it, a deployment must meet at least these
requirements:

1. The host runs only EnvVault, is patched, and allows administrative access (SSH) to named
   operators only, with keys, not passwords.
2. The keyring and integrity key are files outside the image and the repository, mode 0400,
   owned by the service user, mounted read only into the API container; nothing else mounts
   them.
3. The disk holding them is encrypted, and host backups that include it are treated as
   secrets.
4. A recovery key exists offline and a verified keyring backup is stored apart from it.
5. Production has its own Neon branch, Neon Auth URL, keyring, integrity key and recovery key.
6. Operator commands (`pnpm ops`) are run only by those operators, and their use is logged.
7. Real secrets are stored only after an independent security assessment of the deployment.
