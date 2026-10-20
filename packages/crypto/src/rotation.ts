import { isCryptoError, type CryptoErrorCode } from './errors.js';
import type { SecretCipher, SecretEncryptionContext, SecretEnvelope } from './secret-cipher.js';

export interface RewrapItem {
  /** Opaque record id (e.g. the secret version id). Reported back, never a value. */
  readonly id: string;
  readonly envelope: SecretEnvelope;
  readonly context: SecretEncryptionContext;
}

export interface RewrapFailure {
  readonly id: string;
  /** Error category only; never key material, plaintext or ciphertext. */
  readonly code: CryptoErrorCode | 'STORE_FAILED' | 'UNKNOWN';
}

export interface RewrapProgress {
  processed: number;
  rewrapped: number;
  alreadyCurrent: number;
  failed: RewrapFailure[];
}

export interface RewrapOptions {
  /**
   * Stores a re-wrapped envelope. Must update only the wrapped key and key
   * reference, and should be conditional on the old key version
   * (compare-and-set) so concurrent runs cannot overwrite newer data.
   */
  store: (item: RewrapItem, envelope: SecretEnvelope) => Promise<void>;
  /** Called after each item with a snapshot of the progress counters. */
  onProgress?: (progress: Readonly<RewrapProgress>) => void;
  /** Stop after this many failures (default: never stop early). */
  maxFailures?: number;
  signal?: AbortSignal;
}

/**
 * Re-wraps data keys onto the active key version. Each item is independent:
 * a failure is recorded (by id and error category) and the run continues.
 * Re-running is safe — items already on the active version are skipped — so
 * an interrupted rotation is resumed by running it again.
 */
export async function rewrapAll(
  cipher: SecretCipher,
  items: Iterable<RewrapItem> | AsyncIterable<RewrapItem>,
  options: RewrapOptions,
): Promise<RewrapProgress> {
  const progress: RewrapProgress = { processed: 0, rewrapped: 0, alreadyCurrent: 0, failed: [] };
  for await (const item of items) {
    if (options.signal?.aborted) break;
    progress.processed += 1;
    let result;
    try {
      result = await cipher.rewrapSecret(item.envelope, item.context);
    } catch (error) {
      progress.failed.push({ id: item.id, code: isCryptoError(error) ? error.code : 'UNKNOWN' });
      options.onProgress?.({ ...progress, failed: [...progress.failed] });
      if (options.maxFailures !== undefined && progress.failed.length >= options.maxFailures) break;
      continue;
    }
    if (!result.changed) {
      progress.alreadyCurrent += 1;
    } else {
      try {
        await options.store(item, result.envelope);
        progress.rewrapped += 1;
      } catch {
        progress.failed.push({ id: item.id, code: 'STORE_FAILED' });
      }
    }
    options.onProgress?.({ ...progress, failed: [...progress.failed] });
    if (options.maxFailures !== undefined && progress.failed.length >= options.maxFailures) break;
  }
  return progress;
}
