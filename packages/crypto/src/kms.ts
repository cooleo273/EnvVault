/**
 * Key-value pairs that are cryptographically bound to an encrypted payload
 * (used as AES-GCM additional authenticated data and passed to the KMS as its
 * encryption context). Decryption fails if the context does not match exactly.
 *
 * Never put secret material in the context: it is stored and logged in clear.
 */
export type EncryptionContext = Readonly<Record<string, string>>;

export interface GeneratedDataKey {
  /** Plaintext data key. Callers must zero it as soon as it is no longer needed. */
  plaintextKey: Buffer;
  /** Data key encrypted under the KMS root key; safe to persist. */
  encryptedKey: Buffer;
  /** Fully-qualified identifier of the KMS root key that wrapped the data key. */
  keyId: string;
}

/**
 * Abstraction over a managed key management service (AWS KMS, Google Cloud KMS,
 * Azure Key Vault, HashiCorp Vault Transit, ...).
 *
 * Root keys live exclusively inside the KMS and never leave it. EnvVault only
 * ever stores data keys in their KMS-encrypted form, never root keys.
 *
 * No implementation ships in this package yet: concrete providers are added in
 * a later phase together with the infrastructure and credentials they require.
 */
export interface KeyManagementProvider {
  /** Stable provider identifier persisted alongside each envelope, e.g. `aws-kms`. */
  readonly providerId: string;

  /** Requests a fresh 256-bit data key from the KMS. */
  generateDataKey(keyId: string, context: EncryptionContext): Promise<GeneratedDataKey>;

  /** Asks the KMS to unwrap a previously generated data key. */
  decryptDataKey(keyId: string, encryptedKey: Buffer, context: EncryptionContext): Promise<Buffer>;
}
