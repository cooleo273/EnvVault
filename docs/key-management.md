# Key management

Key encryption keys (KEKs) are held by a **key provider**. Business code depends only on
the `KeyManagementProvider` interface (`packages/crypto/src/provider.ts`), so a managed
KMS can replace the local provider without changing callers.

> **The local provider is self-managed and for development and testing only.** Its master
> keys live in a file (or an environment variable) and in the API process's memory. That
> is **not** equivalent to a managed or hardware-backed KMS (AWS KMS, Google Cloud KMS,
> Azure Key Vault, HashiCorp Vault Transit): there is no HSM, no access policy, no
> independent audit trail of key use, and anyone who can read the file or the process's
> memory has the keys. The API refuses `ENCRYPTION_PROVIDER=local` with
> `NODE_ENV=production`.

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

## 4. Rotation

1. `pnpm crypto:rotate:dev` adds version _n+1_ as `active`. The previous active version
   becomes `decrypt-only`. The file is written atomically (temporary file, fsync,
   rename), so a crash leaves the old or the new keyring, never a partial one. The
   provider persists before using a new key.
2. Restart the API. New secret versions now use version _n+1_. Existing envelopes still
   decrypt with their own version.
3. **Re-wrap (optional, later)** with `rewrapAll(cipher, items, { store })` from
   `@envvault/crypto`:
   - It unwraps each DEK with its old version, checks it against the value ciphertext
     with the same context, and wraps it under the active version.
   - `ciphertext`, `iv` and `auth_tag` never change.
   - It is idempotent: items already on the active version are skipped. A rerun resumes
     an interrupted rotation.
   - Progress and failures are reported by record id and error code only, never values.
   - The `store` callback should update conditionally (compare-and-set on the old key
     version).
4. **Retire** an old version with `retireKeyVersion(keyring, version, liveReferences)`.
   It refuses while any live envelope still references the version, and refuses the
   active version. The caller must count references, e.g.
   `SELECT count(*) FROM secret_versions WHERE kms_key_version = '<v>'`. Retiring
   destroys the material.

**Phase 3A limits:** rotation and re-wrapping are implemented and tested on synthetic
envelopes only. No job rewrites database rows, and nothing is run against Neon. The
re-wrap job over `secret_versions` and a retire command with a live reference count come
with Phase 3B.

## 5. Moving to a managed KMS

Implement `KeyManagementProvider` for the KMS:

- `generateDataKey` maps to the KMS's GenerateDataKey with an encryption context, and
  `unwrapDataKey` maps to Decrypt.
- `rotateWrappingKey` maps to the KMS's key rotation.

Then extend `ENCRYPTION_PROVIDER` and `loadEncryption()`. Envelopes record `providerId`,
`keyId` and `keyVersion`, so data encrypted under the local provider can be migrated by
re-wrapping each DEK: unwrap with the local provider, wrap with the KMS. A production
deployment needs that reviewed provider. The local provider must not be used.
