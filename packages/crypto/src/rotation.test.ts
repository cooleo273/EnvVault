import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, KeyConfigurationError, KeyNotFoundError } from './errors.js';
import { generateKeyring, retireKeyVersion } from './local/keyring.js';
import { LocalKeyProvider } from './local/local-provider.js';
import { rewrapAll, type RewrapItem } from './rotation.js';
import { SecretCipher, type SecretEnvelope } from './secret-cipher.js';
import { memoryProvider, syntheticContext } from './test-helpers.js';

async function syntheticItems(cipher: SecretCipher, count: number): Promise<RewrapItem[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const context = syntheticContext();
      return {
        id: context.secretVersionId,
        context,
        envelope: await cipher.encryptSecret(`synthetic-value-${String(index)}`, context),
      };
    }),
  );
}

describe('key rotation', () => {
  it('new encryptions use the new version; old ciphertext still decrypts', async () => {
    const store = memoryProvider();
    const cipher = new SecretCipher(store.provider);
    const context = syntheticContext();
    const before = await cipher.encryptSecret('synthetic-before', context);

    const active = await store.provider.rotateWrappingKey();
    expect(active.keyVersion).toBe(2);
    expect(store.keyring.activeVersion).toBe(2);

    const after = await cipher.encryptSecret('synthetic-after', context);
    expect(before.keyVersion).toBe(1);
    expect(after.keyVersion).toBe(2);
    await expect(cipher.decryptSecret(before, context)).resolves.toBe('synthetic-before');
    await expect(cipher.decryptSecret(after, context)).resolves.toBe('synthetic-after');
    expect((await store.provider.listKeyMetadata()).map((key) => key.status)).toEqual([
      'decrypt-only',
      'active',
    ]);
  });

  it('a restarted provider loaded from the persisted keyring still reads both versions', async () => {
    const store = memoryProvider();
    const cipher = new SecretCipher(store.provider);
    const context = syntheticContext();
    const old = await cipher.encryptSecret('synthetic-old', context);
    await store.provider.rotateWrappingKey();
    const fresh = new SecretCipher(new LocalKeyProvider(store.keyring, { nodeEnv: 'test' }));
    await expect(fresh.decryptSecret(old, context)).resolves.toBe('synthetic-old');
  });

  it('refuses to rotate without durable storage', async () => {
    const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
    await expect(provider.rotateWrappingKey()).rejects.toThrow(KeyConfigurationError);
  });

  it('does not switch keys when persisting the rotation fails', async () => {
    const keyring = generateKeyring();
    const provider = new LocalKeyProvider(keyring, {
      nodeEnv: 'test',
      persist: () => Promise.reject(new Error('disk full')),
    });
    await expect(provider.rotateWrappingKey()).rejects.toThrow('disk full');
    expect((await provider.getActiveKeyVersion()).keyVersion).toBe(1);
  });

  it('re-wraps a data key without changing the value ciphertext', async () => {
    const store = memoryProvider();
    const cipher = new SecretCipher(store.provider);
    const context = syntheticContext();
    const original = await cipher.encryptSecret('synthetic-rewrap', context);
    await store.provider.rotateWrappingKey();

    const { envelope, changed } = await cipher.rewrapSecret(original, context);
    expect(changed).toBe(true);
    expect(envelope.keyVersion).toBe(2);
    expect(envelope.wrappedKey.equals(original.wrappedKey)).toBe(false);
    expect(envelope.ciphertext.equals(original.ciphertext)).toBe(true);
    expect(envelope.nonce.equals(original.nonce)).toBe(true);
    expect(envelope.tag.equals(original.tag)).toBe(true);
    await expect(cipher.decryptSecret(envelope, context)).resolves.toBe('synthetic-rewrap');

    // Idempotent: a second re-wrap is a no-op.
    const again = await cipher.rewrapSecret(envelope, context);
    expect(again.changed).toBe(false);
    expect(again.envelope).toBe(envelope);
  });

  it('re-wrapping authenticates the context and the value', async () => {
    const store = memoryProvider();
    const cipher = new SecretCipher(store.provider);
    const context = syntheticContext();
    const original = await cipher.encryptSecret('synthetic-context', context);
    await store.provider.rotateWrappingKey();
    await expect(
      cipher.rewrapSecret(original, { ...context, secretVersionId: randomUUID() }),
    ).rejects.toThrow(DecryptionError);
    const tampered = Buffer.from(original.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(
      cipher.rewrapSecret({ ...original, ciphertext: tampered }, context),
    ).rejects.toThrow(DecryptionError);
  });

  it('a retired version can no longer be used, and re-wrapped data survives retirement', async () => {
    const store = memoryProvider();
    const cipher = new SecretCipher(store.provider);
    const context = syntheticContext();
    const original = await cipher.encryptSecret('synthetic-retire', context);
    await store.provider.rotateWrappingKey();
    const { envelope } = await cipher.rewrapSecret(original, context);

    const retired = retireKeyVersion(store.keyring, 1, 0);
    const next = new SecretCipher(new LocalKeyProvider(retired, { nodeEnv: 'test' }));
    await expect(next.decryptSecret(original, context)).rejects.toThrow(KeyNotFoundError);
    await expect(next.decryptSecret(envelope, context)).resolves.toBe('synthetic-retire');
  });

  describe('rewrapAll', () => {
    it('re-wraps every item, reports progress, and is idempotent on re-run', async () => {
      const store = memoryProvider();
      const cipher = new SecretCipher(store.provider);
      const items = await syntheticItems(cipher, 5);
      await store.provider.rotateWrappingKey();

      const stored = new Map<string, SecretEnvelope>();
      const snapshots: number[] = [];
      const first = await rewrapAll(cipher, items, {
        store: (item, envelope) => {
          stored.set(item.id, envelope);
          return Promise.resolve();
        },
        onProgress: (progress) => snapshots.push(progress.processed),
      });
      expect(first).toEqual({ processed: 5, rewrapped: 5, alreadyCurrent: 0, failed: [] });
      expect(snapshots).toEqual([1, 2, 3, 4, 5]);

      const rerun = await rewrapAll(
        cipher,
        items.map((item) => ({ ...item, envelope: stored.get(item.id) ?? item.envelope })),
        { store: () => Promise.reject(new Error('must not be called')) },
      );
      expect(rerun).toEqual({ processed: 5, rewrapped: 0, alreadyCurrent: 5, failed: [] });
      for (const item of items) {
        const envelope = stored.get(item.id);
        expect(envelope).toBeDefined();
        if (envelope)
          await expect(cipher.decryptSecret(envelope, item.context)).resolves.toMatch(
            /^synthetic-value-/,
          );
      }
    });

    it('records failures by id and category without values, and continues', async () => {
      const store = memoryProvider();
      const cipher = new SecretCipher(store.provider);
      const [good, broken, unstorable] = await syntheticItems(cipher, 3);
      if (!good || !broken || !unstorable) throw new Error('fixture');
      await store.provider.rotateWrappingKey();
      const corrupted: RewrapItem = {
        ...broken,
        envelope: { ...broken.envelope, tag: Buffer.alloc(16) },
      };
      const result = await rewrapAll(cipher, [good, corrupted, unstorable], {
        store: (item) =>
          item.id === unstorable.id ? Promise.reject(new Error('conflict')) : Promise.resolve(),
      });
      expect(result.processed).toBe(3);
      expect(result.rewrapped).toBe(1);
      expect(result.failed).toEqual([
        { id: broken.id, code: 'DECRYPTION_FAILED' },
        { id: unstorable.id, code: 'STORE_FAILED' },
      ]);
      expect(JSON.stringify(result)).not.toContain('synthetic-value');
    });

    it('stops at maxFailures and honours an abort signal', async () => {
      const store = memoryProvider();
      const cipher = new SecretCipher(store.provider);
      const items = await syntheticItems(cipher, 4);
      await store.provider.rotateWrappingKey();
      const broken = items.map((item) => ({
        ...item,
        context: { ...item.context, secretId: randomUUID() },
      }));
      const limited = await rewrapAll(cipher, broken, {
        store: () => Promise.resolve(),
        maxFailures: 2,
      });
      expect(limited.processed).toBe(2);

      const controller = new AbortController();
      controller.abort();
      const aborted = await rewrapAll(cipher, items, {
        store: () => Promise.resolve(),
        signal: controller.signal,
      });
      expect(aborted.processed).toBe(0);
    });
  });
});
