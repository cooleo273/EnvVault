import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7 (48 bit millisecond timestamp, then random bits), the id
 * format of every table. Used where the API must know a row id before the
 * insert, e.g. secret versions, whose id is bound into the ciphertext.
 */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
