# Threat model: secret encryption

Scope: confidentiality and integrity of secret values at rest, with the self managed key
provider. The application wide review (assets, boundaries, OWASP coverage, findings and
residual risks) is in [security-hardening.md](security-hardening.md). Related: [encryption.md](encryption.md),
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

| Threat                                                                                          | Mitigation                                                                                                                                                                                    | Residual risk                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Database dump, backup leak or Neon compromise                                                   | Only ciphertext and wrapped DEKs are stored; KEKs never reach the database                                                                                                                    | None for values while the keyring is safe                                                 |
| Tampering with ciphertext, nonce, tag or wrapped key in the database                            | AES-GCM authentication on both layers; fail closed                                                                                                                                            | Denial of service (a value becomes unreadable)                                            |
| Moving a ciphertext or wrapped key between tenants, projects, environments, secrets or versions | All five ids bound in both AADs                                                                                                                                                               | None                                                                                      |
| Swapping a wrapped key between purposes                                                         | Domain separated AAD labels and the DEK purpose bound in the wrap                                                                                                                             | None                                                                                      |
| Downgrade to an older or unknown envelope format                                                | Strict version and algorithm allow list; unknown means rejected                                                                                                                               | None                                                                                      |
| Decrypting with an attacker chosen key                                                          | The envelope names one key id and version; no fallback or trial decryption                                                                                                                    | None                                                                                      |
| Nonce reuse                                                                                     | Fresh DEK per value; random 96 bit nonces; rotation before 2³² wraps per KEK                                                                                                                  | Negligible                                                                                |
| Keys or values in logs and errors                                                               | Fixed error messages, no `cause`; `DataKey` and provider redacted in `inspect` and JSON; allow listed log serializers plus redaction paths; tests assert no leakage                           | Custom code that logs plaintext                                                           |
| Keys committed to Git                                                                           | `.envvault/` and `.env*` gitignored; init writes outside web served paths                                                                                                                     | A developer forcing `git add -f`                                                          |
| Accidental production use of development keys                                                   | Development keyrings refused with `NODE_ENV=production`; production needs a `self-managed` keyring file and an explicit acknowledgement; self managed keyrings are refused outside production | A misconfigured `NODE_ENV`                                                                |
| Silent key regeneration that loses data                                                         | Keys only from the explicit `crypto:init:dev`; overwriting requires the current key id                                                                                                        | None                                                                                      |
| Loss or corruption of the keyring file                                                          | Encrypted keyring backups under an offline recovery key; restore into an isolated path; coverage check against the database                                                                   | Loss of the keyring and every backup                                                      |
| Tampered or forged keyring backup                                                               | Header bound as AAD under AES-256-GCM; recovery key id is key derived; restored keyring must match the header                                                                                 | Recovery key compromise                                                                   |
| Retiring a key version still needed                                                             | Reference counts per version, change request check, required backup that holds the version                                                                                                    | Database backups older than the rewrap need that backup                                   |
| Interrupted rotation or rewrap                                                                  | Atomic keyring writes; compare and set per row; reruns resume                                                                                                                                 | Rows written by instances not yet restarted stay on the old version until the next rewrap |
| Editing or deleting audit history                                                               | HMAC seal chains with the key outside the database; external head anchoring                                                                                                                   | Unsealed recent events; owner rights plus the integrity key                               |

## 4. Not protected against (local provider)

These require a managed or hardware-backed KMS and operational controls:

- **Compromise of the API host or process.** An attacker who can read the keyring file,
  the environment or process memory obtains the KEKs and can decrypt everything.
- **A malicious operator** with file-system access to the keyring.
- **Key-use auditing.** There is no independent log of who unwrapped which key. A KMS
  provides this.
- **Memory hygiene.** Buffers are zeroed after use, but the JavaScript runtime may keep
  copies (strings, garbage-collected heap, swap).
- **Loss of the keyring and its backups.** There is no escrow service. Keyring backups
  help only if the backup and the offline recovery key both survive.
- **Side channels** in the host or OpenSSL build.

Authorization (who may ask the API to decrypt) is a separate control. Secret routes in
Phase 3B enforce `secret:read` and `secret:write` per environment, and protected
environments never inherit them.
