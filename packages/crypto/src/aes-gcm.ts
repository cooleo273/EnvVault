import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptionError } from './errors.js';

/** AES-256-GCM via node:crypto (OpenSSL). No custom primitives. */
export const AES_KEY_BYTES = 32;
/** 96-bit nonce, the size GCM is specified for. Random and unique per operation. */
export const GCM_NONCE_BYTES = 12;
/** Full 128-bit tag; truncated tags are never accepted. */
export const GCM_TAG_BYTES = 16;

export interface GcmSealed {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function seal(key: Buffer, plaintext: Uint8Array, aad: Buffer): GcmSealed {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Throws {@link DecryptionError} (no OpenSSL details) when authentication fails. */
export function open(key: Buffer, sealed: GcmSealed, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}
