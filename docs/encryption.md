# Encryption

EnvVault encrypts every secret value with **envelope encryption** before it reaches the
database. This document covers the format and lifecycle. Key storage and rotation are in
[key-management.md](key-management.md), and the attacker model is in
[threat-model.md](threat-model.md).

> **Status (Phase 3A).** The cryptographic layer (`packages/crypto`) and its NestJS
> integration (`apps/api/src/encryption`) are implemented and tested with synthetic
> values only. Secret CRUD, which writes real `secret_versions` rows, arrives in Phase 3B.

## 1. Design

```
Key encryption key (KEK)  ── one per key version, held by the key provider
        │ wraps (AES-256-GCM, AAD = wrap context)
        ▼
Data encryption key (DEK) ── fresh 256-bit random key per secret version
        │ encrypts (AES-256-GCM, AAD = value context)
        ▼
Secret value              ── stored only as ciphertext
```

- **Primitives:** AES-256-GCM from `node:crypto` (OpenSSL). Keys and nonces come from
  `crypto.randomBytes` (the OS CSPRNG). There are no custom ciphers, modes or key
  derivation.
- **One DEK per secret version.** Each DEK encrypts exactly one value and is then zeroed.
  Only its wrapped form is stored.
- **Nonces:** a random 96-bit nonce for every encryption and for every wrap. Each DEK is
  used once, so value nonces cannot repeat under the same key. KEK wraps use random
  nonces; rotate the KEK long before 2³² wraps per version (NIST SP 800-38D).
- **Tags:** the full 128-bit GCM tag. Truncated tags are rejected.
- **Domain separation:** every operation authenticates a domain label
  (`envvault/secret-value`, `envvault/data-key-wrap`, `envvault/key-self-test`). Bytes
  produced for one purpose are never accepted for another.
- **Fail closed:** any authentication failure is a `DecryptionError` with a fixed
  message. An envelope names exactly one key version, and that version is used. Nothing
  falls back to another key.

## 2. Context binding (AAD)

`SecretEncryptionContext` names one secret version:

| Field             | Example                 |
| ----------------- | ----------------------- |
| `workspaceId`     | UUID (lowercase)        |
| `projectId`       | UUID                    |
| `environmentId`   | UUID                    |
| `secretId`        | UUID                    |
| `secretVersionId` | UUID of the version row |

The context is bound twice:

1. **Value AAD:** domain `envvault/secret-value`, the envelope format version, the
   algorithm and all five ids.
2. **Wrap AAD:** domain `envvault/data-key-wrap`, the provider, key id, key version,
   DEK purpose (`secret-value`) and all five ids.

Moving a ciphertext or a wrapped key to another tenant, project, environment, secret or
version therefore fails. The value AAD deliberately leaves out the key version, because
re-wrapping changes the key version while the value ciphertext stays immutable.

**Encoding.** The AAD is a canonical, versioned binary format, never string
concatenation:

```
u8 encodingVersion (1)
u16be len ‖ domain
u16be fieldCount
repeat: u16be len ‖ name, u16be len ‖ value     (fixed field order per call site)
```

Length prefixes make the encoding unambiguous: `"ab"+"c"` and `"a"+"bc"` encode
differently. Ids must be canonical lowercase UUIDs, so equivalent spellings cannot
produce different bytes.

## 3. Envelope format (version 1)

| Envelope field  | Size           | `secret_versions` column            |
| --------------- | -------------- | ----------------------------------- |
| `formatVersion` | `1`            | `envelope_version`                  |
| `algorithm`     | `AES-256-GCM`  | `algorithm` (`AES_256_GCM`)         |
| `providerId`    | e.g. `local`   | `encryption_keys.kms_provider`      |
| `keyId`         | string         | `encryption_keys.kms_key_ref`       |
| `keyVersion`    | integer ≥ 1    | `kms_key_version`                   |
| `wrappedKey`    | provider bytes | `encrypted_data_key` (1–4096 bytes) |
| `nonce`         | 12 bytes       | `iv`                                |
| `ciphertext`    | ≤ 65 536 bytes | `ciphertext`                        |
| `tag`           | 16 bytes       | `auth_tag`                          |

For the local provider, `wrappedKey` is 61 bytes:
`format (1) ‖ wrap nonce (12) ‖ encrypted DEK (32) ‖ wrap tag (16)`. Managed KMS
providers return their own opaque blob in the same field.

The database enforces the nonce, tag and size limits with CHECK constraints. A trigger
allows only `encrypted_data_key` and the key reference to change after insert, which is
exactly what re-wrapping needs.

**Validation before decryption** (`assertSecretEnvelope`): the format version and
algorithm must be supported (otherwise `UnsupportedEnvelopeError`). Types, exact nonce
and tag lengths, size limits and an integer key version are checked next (otherwise
`MalformedEnvelopeError`). Only then is a key touched.

## 4. Values

- **Strings only**, encoded as UTF-8, up to **64 KiB** after encoding. Empty, multiline
  and any Unicode values are supported.
- Malformed Unicode (lone surrogates) is rejected rather than silently changed.
  Decryption uses a strict UTF-8 decoder.
- Plaintext buffers and DEKs are zeroed after use. This is best effort: JavaScript
  strings cannot be wiped.

## 5. Errors

| Class                          | `code`                 | Meaning                                                                |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------- |
| `KeyConfigurationError`        | `KEY_CONFIGURATION`    | Keys missing, malformed or wrongly sized; local provider in production |
| `KeyNotFoundError`             | `KEY_NOT_FOUND`        | Unknown or retired key id or version, or another provider              |
| `DecryptionError`              | `DECRYPTION_FAILED`    | Tampering, wrong key or wrong context (indistinguishable)              |
| `MalformedEnvelopeError`       | `MALFORMED_ENVELOPE`   | Structurally invalid envelope                                          |
| `UnsupportedEnvelopeError`     | `UNSUPPORTED_ENVELOPE` | Unknown format version or algorithm                                    |
| `CryptoInputError`             | `INVALID_INPUT`        | Invalid context, oversized or malformed value                          |
| `EncryptionNotConfiguredError` | `NOT_CONFIGURED`       | `ENCRYPTION_PROVIDER=none`                                             |

Messages are fixed strings. Errors never contain key material, plaintext, ciphertext or
OpenSSL details, and never carry a `cause`.

## 6. In the API

`EncryptionModule` (global, **no controllers**) provides:

- `SecretEncryptionService`: `encryptSecret`, `decryptSecret` and `rewrapSecret`. It
  logs failures by error code and secret version id only.
- `KeyManagementService`: `isConfigured`, `status()` (key metadata only) and
  `provider()`.

None of this is reachable over HTTP. Phase 3B adds authenticated, authorized secret
routes on top, using `@RequireEnvironmentPermission('secret:read')` and related
permissions.

## 7. Lifecycle of a secret version (Phase 3B)

1. The API generates the version id (UUIDv7) and builds the context.
2. `encryptSecret` creates a fresh DEK, encrypts the value, wraps the DEK under the
   active KEK and zeroes the DEK.
3. The envelope is inserted into `secret_versions` in the same transaction as the
   metadata.
4. Reading loads the row, validates the envelope, unwraps with exactly the referenced
   key version, then decrypts and authenticates.
5. Rotation re-wraps DEKs without touching `ciphertext`, `iv` or `auth_tag` (see
   [key-management.md](key-management.md)).
