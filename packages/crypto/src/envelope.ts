import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptionContext, KeyManagementProvider } from './kms.js';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALGORITHM = 'AES-256-GCM';

const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Persistable representation of an envelope-encrypted value. Contains no plaintext key material.
 * Envelopes read back from storage are untrusted input, so `version` and `algorithm` are
 * deliberately wide types and are validated on decryption.
 */
export interface EncryptedEnvelope {
  version: number;
  algorithm: string;
  kmsProvider: string;
  keyId: string;
  /** Base64 data key, encrypted by the KMS root key. */
  encryptedDataKey: string;
  /** Base64 96-bit nonce, unique per encryption. */
  iv: string;
  /** Base64 128-bit GCM authentication tag. */
  authTag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

export class EnvelopeDecryptionError extends Error {
  constructor(message = 'Unable to decrypt envelope') {
    super(message);
    this.name = 'EnvelopeDecryptionError';
  }
}

/**
 * Canonical (key-sorted) serialisation of the encryption context so that the
 * same logical context always yields the same AAD bytes.
 */
export function canonicalizeContext(context: EncryptionContext): Buffer {
  // Default code-unit ordering on purpose: localeCompare is locale-dependent and
  // could produce different AAD bytes on differently configured hosts.
  const sorted = Object.keys(context)
    .sort()
    .map((key) => [key, context[key]]);
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/**
 * Envelope encryption: each value is encrypted with a fresh data key obtained
 * from the KMS; only the KMS-wrapped data key is stored next to the ciphertext.
 * Uses the platform's AES-256-GCM implementation (node:crypto); no custom primitives.
 */
export class EnvelopeCipher {
  constructor(
    private readonly kms: KeyManagementProvider,
    private readonly rootKeyId: string,
  ) {
    if (rootKeyId.trim() === '') {
      throw new Error('A KMS root key identifier is required');
    }
  }

  async encrypt(
    plaintext: string | Uint8Array,
    context: EncryptionContext,
  ): Promise<EncryptedEnvelope> {
    const dataKey = await this.kms.generateDataKey(this.rootKeyId, context);
    try {
      if (dataKey.plaintextKey.length !== KEY_LENGTH_BYTES) {
        throw new Error('KMS returned a data key of unexpected length');
      }
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey.plaintextKey, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      cipher.setAAD(canonicalizeContext(context));
      const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
      const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);

      return {
        version: ENVELOPE_VERSION,
        algorithm: ENVELOPE_ALGORITHM,
        kmsProvider: this.kms.providerId,
        keyId: dataKey.keyId,
        encryptedDataKey: dataKey.encryptedKey.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      dataKey.plaintextKey.fill(0);
    }
  }

  async decrypt(envelope: EncryptedEnvelope, context: EncryptionContext): Promise<Buffer> {
    if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ENVELOPE_ALGORITHM) {
      throw new EnvelopeDecryptionError('Unsupported envelope version or algorithm');
    }
    if (envelope.kmsProvider !== this.kms.providerId) {
      throw new EnvelopeDecryptionError('Envelope was produced by a different KMS provider');
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new EnvelopeDecryptionError('Malformed envelope');
    }

    const plaintextKey = await this.kms.decryptDataKey(
      envelope.keyId,
      Buffer.from(envelope.encryptedDataKey, 'base64'),
      context,
    );
    try {
      const decipher = createDecipheriv('aes-256-gcm', plaintextKey, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAAD(canonicalizeContext(context));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
    } catch {
      // Do not leak OpenSSL details; tampering and a wrong context look identical.
      throw new EnvelopeDecryptionError();
    } finally {
      plaintextKey.fill(0);
    }
  }
}
