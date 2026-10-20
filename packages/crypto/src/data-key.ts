import { inspect } from 'node:util';
import { CryptoInputError } from './errors.js';

export const DATA_KEY_BYTES = 32;

/**
 * A plaintext data encryption key (DEK). The bytes live in a private field and
 * are never rendered by `util.inspect`, `JSON.stringify` or string conversion.
 * Call {@link DataKey.destroy} as soon as the key is no longer needed; it
 * zeroes the memory (best effort: JavaScript cannot guarantee no other copy).
 */
export class DataKey {
  readonly #material: Buffer;
  #destroyed = false;

  private constructor(material: Buffer) {
    this.#material = material;
  }

  /** Takes ownership of `material` (it is zeroed on destroy). */
  static fromBytes(material: Buffer): DataKey {
    if (material.length !== DATA_KEY_BYTES) {
      throw new CryptoInputError('Data key has an invalid length');
    }
    return new DataKey(material);
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Runs `fn` with the key bytes. The buffer must not be retained after `fn` returns. */
  use<T>(fn: (material: Buffer) => T): T {
    if (this.#destroyed) {
      throw new CryptoInputError('Data key has been destroyed');
    }
    return fn(this.#material);
  }

  destroy(): void {
    this.#material.fill(0);
    this.#destroyed = true;
  }

  toJSON(): string {
    return '[DataKey]';
  }

  toString(): string {
    return '[DataKey]';
  }

  [inspect.custom](): string {
    return '[DataKey]';
  }
}
