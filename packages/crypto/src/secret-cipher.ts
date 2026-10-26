import { AAD_DOMAINS, encodeAad } from './aad.js';
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, open, seal } from './aes-gcm.js';
import {
  CryptoInputError,
  KeyNotFoundError,
  MalformedEnvelopeError,
  UnsupportedEnvelopeError,
} from './errors.js';
import type { DataKeyContext, KeyManagementProvider } from './provider.js';
import { assertServerRuntime } from './runtime.js';

/** Envelope format written today. Older formats get explicit decoders when they change. */
export const SECRET_ENVELOPE_FORMAT_VERSION = 1;
export const SECRET_ENVELOPE_ALGORITHM = 'AES-256-GCM';
/** Matches the `secret_versions.ciphertext` CHECK (octet_length <= 65536). */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_WRAPPED_KEY_BYTES = 4096;
const MAX_KEY_ID_LENGTH = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Identifies exactly one secret version. Bound (as AAD) to both the value
 * ciphertext and the wrapped data key, so neither can be replayed under
 * another tenant, project, environment, secret or version.
 * All ids are canonical lowercase UUIDs.
 */
export interface SecretEncryptionContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly secretId: string;
  readonly secretVersionId: string;
}

/**
 * Versioned envelope for one secret version. Maps onto `secret_versions`:
 * ciphertext/nonce/tag → `ciphertext`/`iv`/`auth_tag`, `wrappedKey` →
 * `encrypted_data_key`, `keyId` → the referenced `encryption_keys.kms_key_ref`,
 * `keyVersion` → `kms_key_version`, `formatVersion` → `envelope_version`.
 *
 * `wrappedKey` is provider-defined; the local provider stores
 * `format(1) || wrap nonce(12) || encrypted data key(32) || wrap tag(16)`.
 */
export interface SecretEnvelope {
  readonly formatVersion: number;
  readonly algorithm: string;
  readonly providerId: string;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly wrappedKey: Buffer;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface RewrapResult {
  readonly envelope: SecretEnvelope;
  /** False when the envelope already used the active key version (idempotent). */
  readonly changed: boolean;
}

const CONTEXT_FIELDS = [
  'workspaceId',
  'projectId',
  'environmentId',
  'secretId',
  'secretVersionId',
] as const;

/** Validates the context and returns its fields in canonical order. */
export function contextFields(
  context: SecretEncryptionContext,
): readonly (readonly [string, string])[] {
  const record: unknown = context;
  if (typeof record !== 'object' || record === null) {
    throw new CryptoInputError('Encryption context is required');
  }
  return CONTEXT_FIELDS.map((name) => {
    const value: unknown = (record as Record<string, unknown>)[name];
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new CryptoInputError(`Encryption context field ${name} must be a lowercase UUID`);
    }
    return [name, value] as const;
  });
}

function dataKeyContext(context: SecretEncryptionContext): DataKeyContext {
  return { purpose: 'secret-value', fields: contextFields(context) };
}

/**
 * The value AAD binds the envelope format, the algorithm and the context.
 * It deliberately excludes the key reference: re-wrapping changes the key
 * version while the value ciphertext stays immutable.
 */
function valueAad(formatVersion: number, context: SecretEncryptionContext): Buffer {
  return encodeAad(AAD_DOMAINS.secretValue, [
    ['formatVersion', String(formatVersion)],
    ['algorithm', SECRET_ENVELOPE_ALGORITHM],
    ...contextFields(context),
  ]);
}

function encodePlaintext(plaintext: string): Buffer {
  if (typeof plaintext !== 'string') {
    throw new CryptoInputError('Secret value must be a string');
  }
  // Lone surrogates would be silently replaced by U+FFFD during UTF-8 encoding.
  if (!(plaintext as unknown as { isWellFormed(): boolean }).isWellFormed()) {
    throw new CryptoInputError('Secret value is not well-formed Unicode');
  }
  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.length > MAX_SECRET_VALUE_BYTES) {
    bytes.fill(0);
    throw new CryptoInputError('Secret value exceeds the maximum size');
  }
  return bytes;
}

function isBufferOf(value: unknown, length?: number, max?: number): value is Buffer {
  if (!Buffer.isBuffer(value)) return false;
  if (length !== undefined) return value.length === length;
  return value.length >= 1 && value.length <= (max ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Strictly validates an untrusted envelope (e.g. read back from the database)
 * before any key is touched.
 */
export function assertSecretEnvelope(value: unknown): asserts value is SecretEnvelope {
  if (typeof value !== 'object' || value === null) throw new MalformedEnvelopeError();
  const envelope = value as Record<string, unknown>;
  if (envelope.formatVersion !== SECRET_ENVELOPE_FORMAT_VERSION) {
    throw new UnsupportedEnvelopeError('Unsupported envelope format version');
  }
  if (envelope.algorithm !== SECRET_ENVELOPE_ALGORITHM) {
    throw new UnsupportedEnvelopeError('Unsupported envelope algorithm');
  }
  if (typeof envelope.providerId !== 'string' || envelope.providerId === '') {
    throw new MalformedEnvelopeError();
  }
  if (
    typeof envelope.keyId !== 'string' ||
    envelope.keyId === '' ||
    envelope.keyId.length > MAX_KEY_ID_LENGTH
  ) {
    throw new MalformedEnvelopeError();
  }
  if (
    typeof envelope.keyVersion !== 'number' ||
    !Number.isSafeInteger(envelope.keyVersion) ||
    envelope.keyVersion < 1
  ) {
    throw new MalformedEnvelopeError();
  }
  if (!isBufferOf(envelope.wrappedKey, undefined, MAX_WRAPPED_KEY_BYTES)) {
    throw new MalformedEnvelopeError();
  }
  if (!isBufferOf(envelope.nonce, GCM_NONCE_BYTES) || !isBufferOf(envelope.tag, GCM_TAG_BYTES)) {
    throw new MalformedEnvelopeError();
  }
  if (
    !Buffer.isBuffer(envelope.ciphertext) ||
    envelope.ciphertext.length > MAX_SECRET_VALUE_BYTES
  ) {
    throw new MalformedEnvelopeError();
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Envelope encryption of secret values: a fresh random data key per secret
 * version encrypts the value (AES-256-GCM); the provider wraps that data key
 * under its active key encryption key. Only the wrapped key is persisted.
 */
export class SecretCipher {
  constructor(private readonly provider: KeyManagementProvider) {
    assertServerRuntime();
  }

  get providerId(): string {
    return this.provider.providerId;
  }

  async encryptSecret(
    plaintext: string,
    context: SecretEncryptionContext,
  ): Promise<SecretEnvelope> {
    const bytes = encodePlaintext(plaintext);
    try {
      const aad = valueAad(SECRET_ENVELOPE_FORMAT_VERSION, context);
      const { dataKey, wrapped } = await this.provider.generateDataKey(dataKeyContext(context));
      try {
        const sealed = dataKey.use((key) => seal(key, bytes, aad));
        return {
          formatVersion: SECRET_ENVELOPE_FORMAT_VERSION,
          algorithm: SECRET_ENVELOPE_ALGORITHM,
          providerId: wrapped.providerId,
          keyId: wrapped.keyId,
          keyVersion: wrapped.keyVersion,
          wrappedKey: wrapped.wrappedKey,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          tag: sealed.tag,
        };
      } finally {
        dataKey.destroy();
      }
    } finally {
      bytes.fill(0);
    }
  }

  async decryptSecret(envelope: SecretEnvelope, context: SecretEncryptionContext): Promise<string> {
    assertSecretEnvelope(envelope);
    const aad = valueAad(envelope.formatVersion, context);
    if (envelope.providerId !== this.provider.providerId) {
      throw new KeyNotFoundError();
    }
    const dataKey = await this.provider.unwrapDataKey(envelope, dataKeyContext(context));
    let plaintext: Buffer | undefined;
    try {
      plaintext = dataKey.use((key) => open(key, envelope, aad));
      return UTF8.decode(plaintext);
    } catch (error) {
      if (error instanceof TypeError) throw new MalformedEnvelopeError();
      throw error;
    } finally {
      plaintext?.fill(0);
      dataKey.destroy();
    }
  }

  /**
   * Proves an envelope decrypts under its context without producing the
   * value: the plaintext stays a buffer that is zeroed before returning, so
   * operator checks never hold secrets as immutable strings.
   */
  async verifySecret(envelope: SecretEnvelope, context: SecretEncryptionContext): Promise<void> {
    assertSecretEnvelope(envelope);
    if (envelope.providerId !== this.provider.providerId) {
      throw new KeyNotFoundError();
    }
    const aad = valueAad(envelope.formatVersion, context);
    const dataKey = await this.provider.unwrapDataKey(envelope, dataKeyContext(context));
    try {
      dataKey.use((key) => open(key, envelope, aad)).fill(0);
    } finally {
      dataKey.destroy();
    }
  }

  /**
   * Re-wraps the data key under the provider's active key version without
   * touching the value ciphertext. Idempotent: an envelope already on the
   * active version is returned unchanged. The old wrapped key is authenticated
   * (with the same context) before the new one is produced.
   */
  async rewrapSecret(
    envelope: SecretEnvelope,
    context: SecretEncryptionContext,
  ): Promise<RewrapResult> {
    assertSecretEnvelope(envelope);
    if (envelope.providerId !== this.provider.providerId) {
      throw new KeyNotFoundError();
    }
    const active = await this.provider.getActiveKeyVersion();
    if (envelope.keyId === active.keyId && envelope.keyVersion === active.keyVersion) {
      return { envelope, changed: false };
    }
    const keyContext = dataKeyContext(context);
    const dataKey = await this.provider.unwrapDataKey(envelope, keyContext);
    try {
      // Prove the data key and context match the value before committing to a new wrap.
      const check = dataKey.use((key) =>
        open(key, envelope, valueAad(envelope.formatVersion, context)),
      );
      check.fill(0);
      const wrapped = await this.provider.wrapDataKey(dataKey, keyContext);
      return {
        envelope: {
          ...envelope,
          providerId: wrapped.providerId,
          keyId: wrapped.keyId,
          keyVersion: wrapped.keyVersion,
          wrappedKey: wrapped.wrappedKey,
        },
        changed: true,
      };
    } finally {
      dataKey.destroy();
    }
  }
}
