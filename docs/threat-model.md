# Threat model: secret encryption

Scope: confidentiality and integrity of secret values at rest, with the Phase 3A
self-managed key provider. Related: [encryption.md](encryption.md),
[key-management.md](key-management.md), [authorization.md](authorization.md) and
[architecture.md §3](architecture.md#3-trust-boundaries).

## 1. Assets

| Asset                       | Where it lives                                                |
| --------------------------- | ------------------------------------------------------------- |
| Secret values (plaintext)   | Only in API memory while encrypting or decrypting             |
| Data encryption keys (DEKs) | Wrapped in `secret_versions`; plaintext briefly in API memory |
| Key encryption keys (KEKs)  | Keyring file or env var on the API host; API memory           |
| Envelope metadata           | PostgreSQL (Neon)                                             |

## 2. Trust boundaries

```
Browser ──(HTTPS, session cookie)──► Next.js server ──(short-lived JWT)──► API ──► PostgreSQL (Neon)
                                                                            │
                                                                            └──► keyring (local file / env var)
```

- **Browser and Next.js** never see KEKs or DEKs. `@envvault/crypto` is server-only: its
  `browser` export throws, and providers refuse a `window` runtime.
- **The API** is the only component that holds keys and plaintext.
- **The database** is untrusted for confidentiality. It holds ciphertext, wrapped keys
  and key ids, never KEKs.

## 3. Threats and mitigations

| Threat                                                                                          | Mitigation                                                                                                                                                          | Residual risk                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Database dump, backup leak or Neon compromise                                                   | Only ciphertext and wrapped DEKs are stored; KEKs never reach the database                                                                                          | None for values while the keyring is safe      |
| Tampering with ciphertext, nonce, tag or wrapped key in the database                            | AES-GCM authentication on both layers; fail closed                                                                                                                  | Denial of service (a value becomes unreadable) |
| Moving a ciphertext or wrapped key between tenants, projects, environments, secrets or versions | All five ids bound in both AADs                                                                                                                                     | —                                              |
| Swapping a wrapped key between purposes                                                         | Domain-separated AAD labels and the DEK purpose bound in the wrap                                                                                                   | —                                              |
| Downgrade to an older or unknown envelope format                                                | Strict version and algorithm allow-list; unknown means rejected                                                                                                     | —                                              |
| Decrypting with an attacker-chosen key                                                          | The envelope names one key id and version; no fallback or trial decryption                                                                                          | —                                              |
| Nonce reuse                                                                                     | Fresh DEK per value; random 96-bit nonces; rotation before 2³² wraps per KEK                                                                                        | Negligible                                     |
| Keys or values in logs and errors                                                               | Fixed error messages, no `cause`; `DataKey` and provider redacted in `inspect` and JSON; allow-listed log serializers plus redaction paths; tests assert no leakage | Custom code that logs plaintext                |
| Keys committed to Git                                                                           | `.envvault/` and `.env*` gitignored; init writes outside web-served paths                                                                                           | A developer forcing `git add -f`               |
| Accidental production use of development keys                                                   | Local provider refused with `NODE_ENV=production` (env validation, provider, CLI)                                                                                   | A misconfigured `NODE_ENV`                     |
| Silent key regeneration that loses data                                                         | Keys only from the explicit `crypto:init:dev`; overwriting requires the current key id                                                                              | —                                              |

## 4. Not protected against (local provider)

These require a managed or hardware-backed KMS and operational controls:

- **Compromise of the API host or process.** An attacker who can read the keyring file,
  the environment or process memory obtains the KEKs and can decrypt everything.
- **A malicious operator** with file-system access to the keyring.
- **Key-use auditing.** There is no independent log of who unwrapped which key. A KMS
  provides this.
- **Memory hygiene.** Buffers are zeroed after use, but the JavaScript runtime may keep
  copies (strings, garbage-collected heap, swap).
- **Loss of the keyring.** There is no escrow. Without a protected backup, encrypted
  secrets are unrecoverable.
- **Side channels** in the host or OpenSSL build.

Authorization (who may ask the API to decrypt) is a separate control. Secret routes in
Phase 3B enforce `secret:read` and `secret:write` per environment, and protected
environments never inherit them.
