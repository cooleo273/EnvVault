import { randomUUID } from 'node:crypto';
import { generateKeyring, type Keyring } from './local/keyring.js';
import { LocalKeyProvider } from './local/local-provider.js';
import type { SecretEncryptionContext } from './secret-cipher.js';

/** Synthetic fixtures only. Test-only module (excluded from the build). */
export function syntheticContext(): SecretEncryptionContext {
  return {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    environmentId: randomUUID(),
    secretId: randomUUID(),
    secretVersionId: randomUUID(),
  };
}

export interface MemoryKeyringStore {
  keyring: Keyring;
  provider: LocalKeyProvider;
}

/** A provider whose "persisted" keyring lives in memory, so rotation works in tests. */
export function memoryProvider(keyring: Keyring = generateKeyring()): MemoryKeyringStore {
  const store = { keyring } as MemoryKeyringStore;
  store.provider = new LocalKeyProvider(keyring, {
    nodeEnv: 'test',
    reload: () => Promise.resolve(store.keyring),
    persist: (next) => {
      store.keyring = next;
      return Promise.resolve();
    },
  });
  return store;
}

export const SYNTHETIC_SECRET = 'synthetic-test-value-7f3c9a';
