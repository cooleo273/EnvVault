import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { AES_KEY_BYTES } from './aes-gcm.js';
import { KeyConfigurationError } from './errors.js';
import { decodeKeyMaterial } from './local/keyring.js';
import { readProtectedFile, writeProtectedFile } from './local/keyring-file.js';

/**
 * Server integrity keys: HMAC keys for tamper evidence (audit seals) and
 * request fingerprints (idempotency). Held in a file outside the database,
 * so someone who can only change database rows cannot forge a valid MAC.
 * Each purpose uses its own HKDF subkey, so a MAC made for one purpose is
 * never valid for another.
 */
export const INTEGRITY_KEY_FORMAT = 'envvault.integrity-key';
const FORMAT_VERSION = 1;
const KEY_ID_PATTERN = /^ik-[0-9a-f]{16}$/;
export const MAC_BYTES = 32;

export const INTEGRITY_PURPOSES = ['audit-seal', 'idempotency', 'service-credential'] as const;
export type IntegrityPurpose = (typeof INTEGRITY_PURPOSES)[number];

interface IntegrityKeyEntry {
  keyId: string;
  createdAt: string;
  key: string;
}

export interface IntegrityKeyFile {
  format: typeof INTEGRITY_KEY_FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  activeKeyId: string;
  keys: IntegrityKeyEntry[];
}

function newEntry(now: Date): IntegrityKeyEntry {
  const material = randomBytes(AES_KEY_BYTES);
  try {
    return {
      keyId: `ik-${randomBytes(8).toString('hex')}`,
      createdAt: now.toISOString(),
      key: material.toString('base64'),
    };
  } finally {
    material.fill(0);
  }
}

export function generateIntegrityKeyFile(now = new Date()): IntegrityKeyFile {
  const entry = newEntry(now);
  return {
    format: INTEGRITY_KEY_FORMAT,
    formatVersion: FORMAT_VERSION,
    activeKeyId: entry.keyId,
    keys: [entry],
  };
}

/** Adds a new active key. Older keys stay for verifying what they sealed. */
export function rotateIntegrityKeyFile(file: IntegrityKeyFile, now = new Date()): IntegrityKeyFile {
  const current = parseIntegrityKeyFile(file);
  const entry = newEntry(now);
  return { ...current, activeKeyId: entry.keyId, keys: [...current.keys, entry] };
}

export function parseIntegrityKeyFile(input: unknown): IntegrityKeyFile {
  if (typeof input !== 'object' || input === null) {
    throw new KeyConfigurationError('Integrity key file must be a JSON object');
  }
  const value = input as Record<string, unknown>;
  if (value.format !== INTEGRITY_KEY_FORMAT || value.formatVersion !== FORMAT_VERSION) {
    throw new KeyConfigurationError('Integrity key file has an unknown format');
  }
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100) {
    throw new KeyConfigurationError('Integrity key file has no usable keys');
  }
  const keys: IntegrityKeyEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.keys as unknown[]) {
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.keyId !== 'string' ||
      !KEY_ID_PATTERN.test(entry.keyId) ||
      ids.has(entry.keyId) ||
      typeof entry.createdAt !== 'string' ||
      typeof entry.key !== 'string'
    ) {
      throw new KeyConfigurationError('Integrity key entry is invalid');
    }
    decodeKeyMaterial(entry.key).fill(0);
    ids.add(entry.keyId);
    keys.push({ keyId: entry.keyId, createdAt: entry.createdAt, key: entry.key });
  }
  if (typeof value.activeKeyId !== 'string' || !ids.has(value.activeKeyId)) {
    throw new KeyConfigurationError('Integrity key file names an unknown active key');
  }
  return {
    format: INTEGRITY_KEY_FORMAT,
    formatVersion: FORMAT_VERSION,
    activeKeyId: value.activeKeyId,
    keys,
  };
}

export function serializeIntegrityKeyFile(file: IntegrityKeyFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export async function readIntegrityKeyFile(path: string): Promise<IntegrityKeyFile> {
  const text = await readProtectedFile(path, 'Integrity key file');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeyConfigurationError('Integrity key file is not valid JSON');
  }
  return parseIntegrityKeyFile(value);
}

export async function writeIntegrityKeyFile(
  path: string,
  file: IntegrityKeyFile,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  await writeProtectedFile(path, serializeIntegrityKeyFile(parseIntegrityKeyFile(file)), options);
}

/** HMAC-SHA256 under per purpose subkeys. Material stays private and is never rendered. */
export class IntegrityKeys {
  readonly #subkeys = new Map<string, Buffer>();
  readonly activeKeyId: string;

  constructor(file: IntegrityKeyFile) {
    const parsed = parseIntegrityKeyFile(file);
    this.activeKeyId = parsed.activeKeyId;
    for (const entry of parsed.keys) {
      const material = decodeKeyMaterial(entry.key);
      try {
        for (const purpose of INTEGRITY_PURPOSES) {
          const subkey = Buffer.from(
            hkdfSync(
              'sha256',
              material,
              Buffer.alloc(0),
              `envvault/integrity/${purpose}`,
              AES_KEY_BYTES,
            ),
          );
          this.#subkeys.set(`${entry.keyId}:${purpose}`, subkey);
        }
      } finally {
        material.fill(0);
      }
    }
  }

  /** Creates a process local key set, for development without a key file. */
  static ephemeral(): IntegrityKeys {
    return new IntegrityKeys(generateIntegrityKeyFile());
  }

  has(keyId: string): boolean {
    return this.#subkeys.has(`${keyId}:audit-seal`);
  }

  mac(purpose: IntegrityPurpose, data: Buffer, keyId = this.activeKeyId): Buffer {
    const subkey = this.#subkeys.get(`${keyId}:${purpose}`);
    if (!subkey) throw new KeyConfigurationError('Unknown integrity key');
    return createHmac('sha256', subkey).update(data).digest();
  }

  verify(purpose: IntegrityPurpose, data: Buffer, mac: Buffer, keyId: string): boolean {
    if (!this.has(keyId) || mac.length !== MAC_BYTES) return false;
    return timingSafeEqual(this.mac(purpose, data, keyId), mac);
  }

  destroy(): void {
    for (const key of this.#subkeys.values()) key.fill(0);
    this.#subkeys.clear();
  }

  toJSON(): Record<string, unknown> {
    return { activeKeyId: this.activeKeyId };
  }

  [inspect.custom](): string {
    return `IntegrityKeys { activeKeyId: '${this.activeKeyId}' }`;
  }
}
