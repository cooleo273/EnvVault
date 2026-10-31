import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CryptoError,
  CryptoInputError,
  DecryptionError,
  KeyNotFoundError,
  MalformedEnvelopeError,
  UnsupportedEnvelopeError,
} from './errors.js';
import { generateKeyring } from './local/keyring.js';
import { LOCAL_WRAPPED_KEY_BYTES, LocalKeyProvider } from './local/local-provider.js';
import type { DataKeyContext, KeyManagementProvider } from './provider.js';
import {
  MAX_SECRET_VALUE_BYTES,
  SecretCipher,
  type SecretEncryptionContext,
  type SecretEnvelope,
} from './secret-cipher.js';
import { memoryProvider, SYNTHETIC_SECRET, syntheticContext } from './test-helpers.js';

function flip(buffer: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('SecretCipher', () => {
  let provider: LocalKeyProvider;
  let cipher: SecretCipher;
  let context: SecretEncryptionContext;

  beforeEach(() => {
    provider = memoryProvider().provider;
    cipher = new SecretCipher(provider);
    context = syntheticContext();
  });

  describe('round trips', () => {
    it.each([
      ['ascii', SYNTHETIC_SECRET],
      ['empty', ''],
      ['unicode', 'pässwörd-密码-🔐-ﷺ-\u0000-end'],
      ['multiline', '-----BEGIN SYNTHETIC KEY-----\nAAAA\r\nBBBB\n-----END SYNTHETIC KEY-----\n'],
      ['maximum size', 'x'.repeat(MAX_SECRET_VALUE_BYTES)],
      ['multi-byte up to the limit', '€'.repeat(Math.floor(MAX_SECRET_VALUE_BYTES / 3))],
    ])('%s value', async (_label, value) => {
      const envelope = await cipher.encryptSecret(value, context);
      expect(envelope.ciphertext).toHaveLength(Buffer.byteLength(value, 'utf8'));
      await expect(cipher.decryptSecret(envelope, context)).resolves.toBe(value);
    });

    it('produces the documented envelope', async () => {
      const envelope = await cipher.encryptSecret(SYNTHETIC_SECRET, context);
      const active = await provider.getActiveKeyVersion();
      expect(envelope).toMatchObject({
        formatVersion: 1,
        algorithm: 'AES-256-GCM',
        providerId: 'local',
        keyId: active.keyId,
        keyVersion: 1,
      });
      expect(envelope.nonce).toHaveLength(12);
      expect(envelope.tag).toHaveLength(16);
      expect(envelope.wrappedKey).toHaveLength(LOCAL_WRAPPED_KEY_BYTES);
    });
  });

  describe('input limits', () => {
    it('rejects values above the limit', async () => {
      await expect(
        cipher.encryptSecret('x'.repeat(MAX_SECRET_VALUE_BYTES + 1), context),
      ).rejects.toThrow(CryptoInputError);
    });

    it('rejects malformed Unicode instead of silently altering it', async () => {
      await expect(cipher.encryptSecret('broken \uD800 surrogate', context)).rejects.toThrow(
        CryptoInputError,
      );
    });

    it.each<[string, Partial<Record<keyof SecretEncryptionContext, unknown>>]>([
      ['missing secret version', { secretVersionId: undefined }],
      ['uppercase id', { workspaceId: randomUUID().toUpperCase() }],
      ['non-uuid id', { projectId: 'production' }],
    ])('rejects an invalid context: %s', async (_label, change) => {
      const invalid = { ...context, ...change } as SecretEncryptionContext;
      await expect(cipher.encryptSecret(SYNTHETIC_SECRET, invalid)).rejects.toThrow(
        CryptoInputError,
      );
    });
  });

  describe('nonces and data keys', () => {
    it('uses a unique nonce and a unique data key for every encryption', async () => {
      const envelopes = await Promise.all(
        Array.from({ length: 200 }, () => cipher.encryptSecret(SYNTHETIC_SECRET, context)),
      );
      const nonces = new Set(envelopes.map((envelope) => envelope.nonce.toString('hex')));
      const wrapNonces = new Set(
        envelopes.map((envelope) => envelope.wrappedKey.subarray(1, 13).toString('hex')),
      );
      const ciphertexts = new Set(envelopes.map((envelope) => envelope.ciphertext.toString('hex')));
      expect(nonces.size).toBe(200);
      expect(wrapNonces.size).toBe(200);
      // Same plaintext, different data keys and nonces: ciphertexts never repeat.
      expect(ciphertexts.size).toBe(200);
    });
  });

  describe('fails closed', () => {
    let envelope: SecretEnvelope;

    beforeEach(async () => {
      envelope = await cipher.encryptSecret(SYNTHETIC_SECRET, context);
    });

    it.each<[string, (envelope: SecretEnvelope) => SecretEnvelope]>([
      ['tampered ciphertext', (e) => ({ ...e, ciphertext: flip(e.ciphertext) })],
      ['tampered authentication tag', (e) => ({ ...e, tag: flip(e.tag, 15) })],
      ['tampered nonce', (e) => ({ ...e, nonce: flip(e.nonce) })],
      ['tampered wrapped data key', (e) => ({ ...e, wrappedKey: flip(e.wrappedKey, 20) })],
      [
        'tampered wrap tag',
        (e) => ({ ...e, wrappedKey: flip(e.wrappedKey, LOCAL_WRAPPED_KEY_BYTES - 1) }),
      ],
      ['truncated ciphertext', (e) => ({ ...e, ciphertext: e.ciphertext.subarray(1) })],
    ])('%s', async (_label, tamper) => {
      await expect(cipher.decryptSecret(tamper(envelope), context)).rejects.toThrow(
        DecryptionError,
      );
    });

    it.each(Object.keys(syntheticContext()) as (keyof SecretEncryptionContext)[])(
      'wrong context: %s',
      async (field) => {
        await expect(
          cipher.decryptSecret(envelope, { ...context, [field]: randomUUID() }),
        ).rejects.toThrow(DecryptionError);
      },
    );

    it('the value ciphertext is bound to the context on its own (defence in depth)', async () => {
      // A provider that ignores the context when unwrapping: only the value AAD can object.
      let wrapContext: DataKeyContext | undefined;
      const blind: KeyManagementProvider = {
        providerId: provider.providerId,
        validateKeyConfiguration: () => provider.validateKeyConfiguration(),
        getActiveKeyVersion: () => provider.getActiveKeyVersion(),
        listKeyMetadata: () => provider.listKeyMetadata(),
        rotateWrappingKey: () => provider.rotateWrappingKey(),
        wrapDataKey: (key, keyContext) => provider.wrapDataKey(key, keyContext),
        generateDataKey: (keyContext) => {
          wrapContext = keyContext;
          return provider.generateDataKey(keyContext);
        },
        unwrapDataKey: (wrapped) =>
          provider.unwrapDataKey(wrapped, wrapContext ?? { purpose: 'secret-value', fields: [] }),
      };
      const blindCipher = new SecretCipher(blind);
      const sealed = await blindCipher.encryptSecret(SYNTHETIC_SECRET, context);
      await expect(blindCipher.decryptSecret(sealed, context)).resolves.toBe(SYNTHETIC_SECRET);
      await expect(
        blindCipher.decryptSecret(sealed, { ...context, environmentId: randomUUID() }),
      ).rejects.toThrow(DecryptionError);
    });

    it('incorrect secret version', async () => {
      const other = await cipher.encryptSecret(SYNTHETIC_SECRET, {
        ...context,
        secretVersionId: randomUUID(),
      });
      // Swapping wrapped keys or whole payloads between versions fails.
      await expect(
        cipher.decryptSecret({ ...envelope, wrappedKey: other.wrappedKey }, context),
      ).rejects.toThrow(DecryptionError);
      await expect(cipher.decryptSecret(other, context)).rejects.toThrow(DecryptionError);
    });

    it('incorrect master key with the same key id', async () => {
      const keyring = generateKeyring();
      const a = new SecretCipher(new LocalKeyProvider(keyring, { nodeEnv: 'test' }));
      const forged = generateKeyring();
      forged.keyId = keyring.keyId;
      const b = new SecretCipher(new LocalKeyProvider(forged, { nodeEnv: 'test' }));
      const sealed = await a.encryptSecret(SYNTHETIC_SECRET, context);
      await expect(b.decryptSecret(sealed, context)).rejects.toThrow(DecryptionError);
    });

    it('a different keyring (unknown key id)', async () => {
      const other = new SecretCipher(memoryProvider().provider);
      await expect(other.decryptSecret(envelope, context)).rejects.toThrow(KeyNotFoundError);
    });

    it('an unknown key version, without trying other versions', async () => {
      await expect(cipher.decryptSecret({ ...envelope, keyVersion: 2 }, context)).rejects.toThrow(
        KeyNotFoundError,
      );
    });

    it('another provider id', async () => {
      await expect(
        cipher.decryptSecret({ ...envelope, providerId: 'aws-kms' }, context),
      ).rejects.toThrow(KeyNotFoundError);
    });

    it.each<[string, (envelope: SecretEnvelope) => unknown, typeof CryptoError]>([
      ['format version 2', (e) => ({ ...e, formatVersion: 2 }), UnsupportedEnvelopeError],
      ['format version 0', (e) => ({ ...e, formatVersion: 0 }), UnsupportedEnvelopeError],
      ['another algorithm', (e) => ({ ...e, algorithm: 'AES-128-CBC' }), UnsupportedEnvelopeError],
      ['short nonce', (e) => ({ ...e, nonce: e.nonce.subarray(1) }), MalformedEnvelopeError],
      ['short tag', (e) => ({ ...e, tag: e.tag.subarray(4) }), MalformedEnvelopeError],
      [
        'string ciphertext',
        (e) => ({ ...e, ciphertext: e.ciphertext.toString('base64') }),
        MalformedEnvelopeError,
      ],
      ['empty wrapped key', (e) => ({ ...e, wrappedKey: Buffer.alloc(0) }), MalformedEnvelopeError],
      [
        'oversized wrapped key',
        (e) => ({ ...e, wrappedKey: Buffer.alloc(5000) }),
        MalformedEnvelopeError,
      ],
      [
        'oversized ciphertext',
        (e) => ({ ...e, ciphertext: Buffer.alloc(MAX_SECRET_VALUE_BYTES + 1) }),
        MalformedEnvelopeError,
      ],
      ['fractional key version', (e) => ({ ...e, keyVersion: 1.5 }), MalformedEnvelopeError],
      ['missing key id', (e) => ({ ...e, keyId: '' }), MalformedEnvelopeError],
      ['not an object', () => 'envelope', MalformedEnvelopeError],
      ['null', () => null, MalformedEnvelopeError],
    ])('malformed or unsupported envelope: %s', async (_label, change, errorType) => {
      await expect(
        cipher.decryptSecret(change(envelope) as SecretEnvelope, context),
      ).rejects.toThrow(errorType);
    });

    it('a wrapped key of the right size with an unknown wrap format', async () => {
      const wrappedKey = Buffer.from(envelope.wrappedKey);
      wrappedKey[0] = 2;
      await expect(cipher.decryptSecret({ ...envelope, wrappedKey }, context)).rejects.toThrow(
        DecryptionError,
      );
    });
  });

  describe('no leakage', () => {
    it('keeps plaintext, data keys and master keys out of envelopes, errors and logs', async () => {
      const keyring = generateKeyring();
      const master = keyring.versions[0]?.key ?? '';
      const local = new LocalKeyProvider(keyring, { nodeEnv: 'test' });
      const subject = new SecretCipher(local);
      const envelope = await subject.encryptSecret(SYNTHETIC_SECRET, context);

      const rendered = [
        JSON.stringify({ ...envelope }),
        inspect(envelope, { depth: 5 }),
        inspect(local, { depth: 5, showHidden: true }),
        JSON.stringify(local),
        inspect(subject, { depth: 5, showHidden: true }),
      ].join('\n');
      expect(rendered).not.toContain(SYNTHETIC_SECRET);
      expect(rendered).not.toContain(master);
      expect(rendered).not.toContain(Buffer.from(master, 'base64').toString('hex'));

      const failures: unknown[] = [];
      for (const attempt of [
        () => subject.decryptSecret({ ...envelope, tag: flip(envelope.tag) }, context),
        () => subject.decryptSecret(envelope, { ...context, secretId: randomUUID() }),
        () => subject.decryptSecret({ ...envelope, keyVersion: 7 }, context),
        () =>
          subject.encryptSecret(
            `${SYNTHETIC_SECRET}${'x'.repeat(MAX_SECRET_VALUE_BYTES)}`,
            context,
          ),
      ]) {
        await attempt().catch((error: unknown) => failures.push(error));
      }
      expect(failures).toHaveLength(4);
      for (const error of failures) {
        expect(error).toBeInstanceOf(CryptoError);
        const text = [
          String(error),
          (error as Error).stack ?? '',
          JSON.stringify(error),
          inspect(error),
        ].join('\n');
        expect(text).not.toContain(SYNTHETIC_SECRET);
        expect(text).not.toContain(master);
        expect((error as Error).cause).toBeUndefined();
        expect(JSON.parse(JSON.stringify(error))).toEqual({
          name: (error as Error).name,
          code: (error as CryptoError).code,
          message: (error as Error).message,
        });
      }
    });

    it('data keys render as a placeholder and are zeroed on destroy', async () => {
      const { dataKey } = await provider.generateDataKey({ purpose: 'secret-value', fields: [] });
      let bytes: Buffer = Buffer.alloc(0);
      dataKey.use((material) => {
        bytes = material;
      });
      const hex = bytes.toString('hex');
      expect(inspect(dataKey)).toBe('[DataKey]');
      expect(JSON.stringify({ dataKey })).toBe('{"dataKey":"[DataKey]"}');
      expect(String(dataKey)).not.toContain(hex);
      dataKey.destroy();
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(() => {
        dataKey.use(() => undefined);
      }).toThrow(CryptoInputError);
    });
  });

  it('verifies an envelope without returning the value, and fails closed when tampered', async () => {
    const cipher = new SecretCipher(new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' }));
    const context = syntheticContext();
    const envelope = await cipher.encryptSecret('synthetic-verify-value', context);
    await expect(cipher.verifySecret(envelope, context)).resolves.toBeUndefined();
    const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;
    await expect(cipher.verifySecret(tampered, context)).rejects.toThrow(DecryptionError);
    await expect(
      cipher.verifySecret(envelope, {
        ...context,
        secretVersionId: syntheticContext().secretVersionId,
      }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('SecretCipher integration credentials', () => {
  const credential = 'synthetic-provider-token-91ce';

  it('round trips and binds the workspace and connection', async () => {
    const cipher = new SecretCipher(memoryProvider().provider);
    const context = { workspaceId: randomUUID(), connectionId: randomUUID() };
    const envelope = await cipher.encryptCredential(credential, context);
    expect(envelope.ciphertext.toString('utf8')).not.toContain(credential);
    await expect(cipher.decryptCredential(envelope, context)).resolves.toBe(credential);
    await expect(
      cipher.decryptCredential(envelope, { ...context, connectionId: randomUUID() }),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      cipher.decryptCredential(envelope, { ...context, workspaceId: randomUUID() }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('keeps credentials and secret values in separate domains', async () => {
    const cipher = new SecretCipher(memoryProvider().provider);
    const secretContext = syntheticContext();
    const secret = await cipher.encryptSecret(SYNTHETIC_SECRET, secretContext);
    const credentialContext = {
      workspaceId: secretContext.workspaceId,
      connectionId: secretContext.secretId,
    };
    await expect(cipher.decryptCredential(secret, credentialContext)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const sealed = await cipher.encryptCredential(credential, credentialContext);
    await expect(cipher.decryptSecret(sealed, secretContext)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('rejects malformed contexts', async () => {
    const cipher = new SecretCipher(memoryProvider().provider);
    await expect(
      cipher.encryptCredential(credential, { workspaceId: 'x', connectionId: randomUUID() }),
    ).rejects.toBeInstanceOf(CryptoInputError);
  });
});
