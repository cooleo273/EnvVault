import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalizeContext,
  EnvelopeCipher,
  EnvelopeDecryptionError,
  type EncryptedEnvelope,
} from './envelope.js';
import type { EncryptionContext, GeneratedDataKey, KeyManagementProvider } from './kms.js';

/**
 * Test-only stand-in for a managed KMS. It wraps data keys with an in-memory
 * AES key and enforces the encryption context, mirroring real KMS semantics.
 * It exists only in this test file and is never exported.
 */
class InMemoryTestKms implements KeyManagementProvider {
  readonly providerId = 'test-kms';
  private readonly rootKey = randomBytes(32);
  lastPlaintextKey: Buffer | undefined;

  generateDataKey(keyId: string, context: EncryptionContext): Promise<GeneratedDataKey> {
    const plaintextKey = randomBytes(32);
    this.lastPlaintextKey = plaintextKey;
    return Promise.resolve({ plaintextKey, encryptedKey: this.wrap(plaintextKey, context), keyId });
  }

  decryptDataKey(
    _keyId: string,
    encryptedKey: Buffer,
    context: EncryptionContext,
  ): Promise<Buffer> {
    const iv = encryptedKey.subarray(0, 12);
    const tag = encryptedKey.subarray(12, 28);
    const body = encryptedKey.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.rootKey, iv);
    decipher.setAAD(canonicalizeContext(context));
    decipher.setAuthTag(tag);
    return Promise.resolve(Buffer.concat([decipher.update(body), decipher.final()]));
  }

  private wrap(key: Buffer, context: EncryptionContext): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.rootKey, iv);
    cipher.setAAD(canonicalizeContext(context));
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
}

const context = { workspaceId: 'ws_1', projectId: 'prj_1', environment: 'production' };

describe('EnvelopeCipher', () => {
  let kms: InMemoryTestKms;
  let cipher: EnvelopeCipher;

  beforeEach(() => {
    kms = new InMemoryTestKms();
    cipher = new EnvelopeCipher(kms, 'root-key-1');
  });

  it('round-trips a value', async () => {
    const envelope = await cipher.encrypt('postgres://user:pass@db/app', context);
    const plaintext = await cipher.decrypt(envelope, context);
    expect(plaintext.toString('utf8')).toBe('postgres://user:pass@db/app');
  });

  it('never stores the plaintext value in the envelope', async () => {
    const envelope = await cipher.encrypt('super-secret-value', context);
    expect(JSON.stringify(envelope)).not.toContain('super-secret-value');
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      kmsProvider: 'test-kms',
      keyId: 'root-key-1',
    });
  });

  it('zeroes the plaintext data key after encrypting', async () => {
    await cipher.encrypt('value', context);
    expect(kms.lastPlaintextKey?.every((byte) => byte === 0)).toBe(true);
  });

  it('uses a unique IV and data key for every encryption', async () => {
    const a = await cipher.encrypt('same', context);
    const b = await cipher.encrypt('same', context);
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedDataKey).not.toBe(b.encryptedDataKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('treats context key order as irrelevant', async () => {
    const envelope = await cipher.encrypt('value', context);
    const reordered = { environment: 'production', projectId: 'prj_1', workspaceId: 'ws_1' };
    await expect(cipher.decrypt(envelope, reordered)).resolves.toEqual(Buffer.from('value'));
  });

  it('fails when the encryption context does not match', async () => {
    const envelope = await cipher.encrypt('value', context);
    await expect(
      cipher.decrypt(envelope, { ...context, environment: 'staging' }),
    ).rejects.toThrow();
  });

  it('fails with a generic error when the ciphertext is tampered with', async () => {
    const envelope = await cipher.encrypt('value', context);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: EncryptedEnvelope = { ...envelope, ciphertext: bytes.toString('base64') };
    await expect(cipher.decrypt(tampered, context)).rejects.toBeInstanceOf(EnvelopeDecryptionError);
  });

  it('rejects envelopes from a different provider or version', async () => {
    const envelope = await cipher.encrypt('value', context);
    await expect(cipher.decrypt({ ...envelope, kmsProvider: 'other' }, context)).rejects.toThrow(
      /different KMS provider/,
    );
    await expect(cipher.decrypt({ ...envelope, version: 2 }, context)).rejects.toThrow(
      /Unsupported/,
    );
  });

  it('requires a root key identifier', () => {
    expect(() => new EnvelopeCipher(kms, '  ')).toThrow(/root key identifier/);
  });
});
