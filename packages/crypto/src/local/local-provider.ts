import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { AAD_DOMAINS, encodeAad } from '../aad.js';
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, open, seal } from '../aes-gcm.js';
import { DATA_KEY_BYTES, DataKey } from '../data-key.js';
import { DecryptionError, KeyConfigurationError, KeyNotFoundError } from '../errors.js';
import type {
  DataKeyContext,
  GeneratedDataKey,
  KeyConfigurationReport,
  KeyManagementProvider,
  KeyMetadata,
  KeyReference,
  WrappedDataKey,
} from '../provider.js';
import { assertServerRuntime } from '../runtime.js';
import {
  decodeKeyMaterial,
  type Keyring,
  keyringMetadata,
  LOCAL_PROVIDER_ID,
  parseKeyring,
  rotateKeyring,
} from './keyring.js';

/** Format byte of the local wrapped-key blob: version || nonce || encrypted DEK || tag. */
export const LOCAL_WRAP_FORMAT_VERSION = 1;
export const LOCAL_WRAPPED_KEY_BYTES = 1 + GCM_NONCE_BYTES + DATA_KEY_BYTES + GCM_TAG_BYTES;

export type LocalKeyringSource =
  { kind: 'file'; path: string } | { kind: 'environment' } | { kind: 'memory' };

export interface LocalKeyProviderOptions {
  /**
   * Persists a rotated keyring (e.g. atomically to the keyring file). Without
   * it, rotation is refused: an in-memory rotation would be lost on restart and
   * every data key wrapped under the new version would become unrecoverable.
   */
  persist?: (keyring: Keyring) => Promise<void>;
  /** Re-reads the persisted keyring before rotating, so concurrent edits are not lost. */
  reload?: () => Promise<Keyring>;
  /** NODE_ENV of the process. The local provider refuses `production`. */
  nodeEnv?: string | undefined;
  source?: LocalKeyringSource;
}

/** Runs synchronous work so that failures surface as rejections, never as synchronous throws. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Key operation failed'));
  }
}

function wrapAad(reference: KeyReference, context: DataKeyContext): Buffer {
  return encodeAad(AAD_DOMAINS.dataKeyWrap, [
    ['provider', LOCAL_PROVIDER_ID],
    ['keyId', reference.keyId],
    ['keyVersion', String(reference.keyVersion)],
    ['purpose', context.purpose],
    ...context.fields,
  ]);
}

/**
 * Self-managed key provider for development and testing. Key encryption keys
 * come from a {@link Keyring} held outside the database and wrap per-version
 * data keys with AES-256-GCM.
 *
 * This is NOT equivalent to a managed or hardware-backed KMS: the master keys
 * exist in this process's memory and in the keyring file. It refuses to run
 * with NODE_ENV=production.
 */
export class LocalKeyProvider implements KeyManagementProvider {
  readonly providerId = LOCAL_PROVIDER_ID;
  readonly #keys = new Map<number, Buffer>();
  #keyring: Keyring;
  readonly #options: LocalKeyProviderOptions;

  constructor(keyring: Keyring, options: LocalKeyProviderOptions = {}) {
    assertServerRuntime();
    if (options.nodeEnv === 'production') {
      throw new KeyConfigurationError(
        'The local key provider is restricted to development and test environments',
      );
    }
    this.#options = options;
    this.#keyring = parseKeyring(keyring);
    this.#load(this.#keyring);
  }

  get source(): LocalKeyringSource {
    return this.#options.source ?? { kind: 'memory' };
  }

  #load(keyring: Keyring): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
    for (const entry of keyring.versions) {
      if (entry.key !== undefined) this.#keys.set(entry.version, decodeKeyMaterial(entry.key));
    }
  }

  #activeReference(): KeyReference {
    return { keyId: this.#keyring.keyId, keyVersion: this.#keyring.activeVersion };
  }

  #kek(reference: KeyReference): Buffer {
    if (reference.keyId !== this.#keyring.keyId) throw new KeyNotFoundError();
    const kek = this.#keys.get(reference.keyVersion);
    if (!kek) throw new KeyNotFoundError();
    return kek;
  }

  #wrap(dataKey: DataKey, context: DataKeyContext): WrappedDataKey {
    const reference = this.#activeReference();
    const kek = this.#kek(reference);
    const sealed = dataKey.use((material) => seal(kek, material, wrapAad(reference, context)));
    return {
      providerId: this.providerId,
      ...reference,
      wrappedKey: Buffer.concat([
        Buffer.from([LOCAL_WRAP_FORMAT_VERSION]),
        sealed.nonce,
        sealed.ciphertext,
        sealed.tag,
      ]),
    };
  }

  validateKeyConfiguration(): Promise<KeyConfigurationReport> {
    return settle(() => this.#selfTest());
  }

  #selfTest(): KeyConfigurationReport {
    // Self-test every usable version: wrap and unwrap a random key.
    for (const [keyVersion, kek] of this.#keys) {
      const probe = randomBytes(DATA_KEY_BYTES);
      const aad = encodeAad(AAD_DOMAINS.selfTest, [
        ['keyId', this.#keyring.keyId],
        ['keyVersion', String(keyVersion)],
      ]);
      const opened = open(kek, seal(kek, probe, aad), aad);
      const ok = opened.equals(probe);
      probe.fill(0);
      opened.fill(0);
      if (!ok) throw new KeyConfigurationError('Key self-test failed');
    }
    return {
      providerId: this.providerId,
      active: this.#activeReference(),
      usableVersions: this.#keys.size,
    };
  }

  getActiveKeyVersion(): Promise<KeyReference> {
    return Promise.resolve(this.#activeReference());
  }

  listKeyMetadata(): Promise<readonly KeyMetadata[]> {
    return Promise.resolve(keyringMetadata(this.#keyring));
  }

  generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey> {
    return settle(() => {
      const dataKey = DataKey.fromBytes(randomBytes(DATA_KEY_BYTES));
      try {
        return { dataKey, wrapped: this.#wrap(dataKey, context) };
      } catch (error) {
        dataKey.destroy();
        throw error;
      }
    });
  }

  wrapDataKey(dataKey: DataKey, context: DataKeyContext): Promise<WrappedDataKey> {
    return settle(() => this.#wrap(dataKey, context));
  }

  unwrapDataKey(wrapped: WrappedDataKey, context: DataKeyContext): Promise<DataKey> {
    return settle(() => this.#unwrap(wrapped, context));
  }

  #unwrap(wrapped: WrappedDataKey, context: DataKeyContext): DataKey {
    if (wrapped.providerId !== this.providerId) throw new KeyNotFoundError();
    const blob = wrapped.wrappedKey;
    if (
      !Buffer.isBuffer(blob) ||
      blob.length !== LOCAL_WRAPPED_KEY_BYTES ||
      blob[0] !== LOCAL_WRAP_FORMAT_VERSION
    ) {
      throw new DecryptionError();
    }
    const kek = this.#kek(wrapped);
    const nonceEnd = 1 + GCM_NONCE_BYTES;
    const keyEnd = nonceEnd + DATA_KEY_BYTES;
    const material = open(
      kek,
      {
        nonce: blob.subarray(1, nonceEnd),
        ciphertext: blob.subarray(nonceEnd, keyEnd),
        tag: blob.subarray(keyEnd),
      },
      wrapAad(wrapped, context),
    );
    return DataKey.fromBytes(material);
  }

  async rotateWrappingKey(): Promise<KeyReference> {
    const persist = this.#options.persist;
    if (!persist) {
      throw new KeyConfigurationError('Key rotation requires a file-backed keyring');
    }
    const latest = this.#options.reload ? await this.#options.reload() : this.#keyring;
    const rotated = rotateKeyring(latest);
    // Persist first: a new key must never be used before it is durably stored.
    await persist(rotated);
    this.#keyring = rotated;
    this.#load(rotated);
    return this.#activeReference();
  }

  /** Zeroes key material held in memory. The provider is unusable afterwards. */
  destroy(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }

  toJSON(): Record<string, unknown> {
    return { providerId: this.providerId, keyId: this.#keyring.keyId };
  }

  [inspect.custom](): string {
    return `LocalKeyProvider { keyId: '${this.#keyring.keyId}', activeVersion: ${String(this.#keyring.activeVersion)} }`;
  }
}
