import { CryptoInputError } from './errors.js';

/** Version of the AAD byte encoding below. Bump only together with a new decoder path. */
export const AAD_ENCODING_VERSION = 1;

/**
 * Domain-separation labels. Every AES-GCM operation authenticates exactly one
 * of these, so bytes produced for one purpose can never be accepted for another
 * (e.g. a secret ciphertext presented as a wrapped data key).
 */
export const AAD_DOMAINS = {
  /** Encryption of a secret value under its data key. */
  secretValue: 'envvault/secret-value',
  /** Wrapping of a data key under a key encryption key. */
  dataKeyWrap: 'envvault/data-key-wrap',
  /** Provider self-test during configuration validation. */
  selfTest: 'envvault/key-self-test',
  /** Encryption of a keyring backup under a recovery key. */
  keyringBackup: 'envvault/keyring-backup',
} as const;

export type AadDomain = (typeof AAD_DOMAINS)[keyof typeof AAD_DOMAINS];

const MAX_FIELD_BYTES = 0xffff;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_FIELD_BYTES) {
    throw new CryptoInputError('Associated data field is too long');
  }
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

/**
 * Canonical, unambiguous AAD encoding:
 *
 *   u8 encodingVersion
 *   u16be len || domain
 *   u16be fieldCount
 *   repeated: u16be len || name, u16be len || value
 *
 * Fields keep the order given by the caller; every call site passes a fixed
 * order, so the same logical context always yields identical bytes. Length
 * prefixes rule out concatenation ambiguities ("ab"+"c" vs "a"+"bc").
 */
export function encodeAad(
  domain: AadDomain,
  fields: readonly (readonly [name: string, value: string])[],
): Buffer {
  const names = new Set<string>();
  const parts: Buffer[] = [Buffer.from([AAD_ENCODING_VERSION]), lengthPrefixed(domain)];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(fields.length);
  parts.push(count);
  for (const [name, value] of fields) {
    if (name === '' || names.has(name)) {
      throw new CryptoInputError('Associated data field names must be unique and non-empty');
    }
    names.add(name);
    parts.push(lengthPrefixed(name), lengthPrefixed(value));
  }
  return Buffer.concat(parts);
}
