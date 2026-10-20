import type { DataKey } from './data-key.js';

/**
 * Identifies one version of one key encryption key (KEK). The id names the key
 * and the version selects its material; both are stored with every envelope so
 * that decryption uses exactly that key and never searches for another.
 */
export interface KeyReference {
  readonly keyId: string;
  readonly keyVersion: number;
}

export type KeyVersionStatus =
  /** Wraps new data keys. Exactly one version is active. */
  | 'active'
  /** Unwraps existing data keys only (after a rotation). */
  | 'decrypt-only'
  /** Key material destroyed; envelopes still referencing it cannot be decrypted. */
  | 'retired';

/** Non-secret description of a key version. Never contains key material. */
export interface KeyMetadata extends KeyReference {
  readonly providerId: string;
  readonly status: KeyVersionStatus;
  readonly createdAt: string;
}

/** What a data key is for. Bound into the wrapping AAD (domain separation). */
export type DataKeyPurpose = 'secret-value';

/**
 * Context a wrapped data key is bound to. Wrapping authenticates these fields,
 * so a wrapped key copied to another secret, version or tenant fails to unwrap.
 */
export interface DataKeyContext {
  readonly purpose: DataKeyPurpose;
  readonly fields: readonly (readonly [name: string, value: string])[];
}

/** A data key wrapped under a KEK. `wrappedKey` is opaque provider-defined bytes. */
export interface WrappedDataKey extends KeyReference {
  readonly providerId: string;
  readonly wrappedKey: Buffer;
}

export interface GeneratedDataKey {
  /** Plaintext key; the caller must destroy it after use. */
  readonly dataKey: DataKey;
  readonly wrapped: WrappedDataKey;
}

export interface KeyConfigurationReport {
  readonly providerId: string;
  readonly active: KeyReference;
  /** Number of versions whose material is available for unwrapping. */
  readonly usableVersions: number;
}

/**
 * Key management boundary. Business logic (e.g. {@link SecretCipher}) depends
 * only on this interface, so the self-managed local provider can later be
 * replaced by AWS KMS, Google Cloud KMS, Azure Key Vault or Vault Transit.
 *
 * There is deliberately no operation that returns a KEK: master keys never
 * leave the provider. Implementations are server-side only.
 */
export interface KeyManagementProvider {
  /** Stable identifier persisted with each envelope, e.g. `local`. */
  readonly providerId: string;

  /** Verifies that keys are present, well formed and usable (performs a self-test). */
  validateKeyConfiguration(): Promise<KeyConfigurationReport>;

  /** The key version that wraps new data keys. */
  getActiveKeyVersion(): Promise<KeyReference>;

  /** Non-secret metadata of every key version known to the provider. */
  listKeyMetadata(): Promise<readonly KeyMetadata[]>;

  /** Generates a fresh random data key and wraps it under the active KEK. */
  generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey>;

  /** Wraps an existing data key under the active KEK (used when re-wrapping). */
  wrapDataKey(dataKey: DataKey, context: DataKeyContext): Promise<WrappedDataKey>;

  /**
   * Unwraps with exactly the referenced key version. Fails closed: an unknown
   * or retired version throws {@link KeyNotFoundError}; any authentication
   * failure throws {@link DecryptionError}. Never falls back to another key.
   */
  unwrapDataKey(wrapped: WrappedDataKey, context: DataKeyContext): Promise<DataKey>;

  /**
   * Administrative: introduces a new active KEK version. Older versions stay
   * available for unwrapping. Not exposed over HTTP.
   */
  rotateWrappingKey(): Promise<KeyReference>;
}
