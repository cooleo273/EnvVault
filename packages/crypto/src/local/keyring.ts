import { randomBytes } from 'node:crypto';
import { AES_KEY_BYTES } from '../aes-gcm.js';
import { CryptoInputError, KeyConfigurationError } from '../errors.js';
import type { KeyMetadata, KeyVersionStatus } from '../provider.js';

/**
 * Self-managed development keyring: one key id with numbered versions of
 * 256-bit key encryption keys. Stored outside the database (a protected local
 * file or a server-side environment variable), never in Git.
 */
export const KEYRING_FORMAT = 'envvault.local-keyring';
export const KEYRING_FORMAT_VERSION = 1;
export const LOCAL_PROVIDER_ID = 'local';

const KEY_ID_PATTERN = /^local-[0-9a-f]{32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_VERSIONS = 1000;

export interface KeyringVersion {
  version: number;
  status: KeyVersionStatus;
  createdAt: string;
  /** Base64 key material; absent once retired. */
  key?: string;
  retiredAt?: string;
}

export interface Keyring {
  format: typeof KEYRING_FORMAT;
  formatVersion: typeof KEYRING_FORMAT_VERSION;
  /** Development keys only: refused when NODE_ENV=production. */
  usage: 'development';
  keyId: string;
  activeVersion: number;
  versions: KeyringVersion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Decodes strict base64 to exactly 32 bytes; rejects anything else. */
export function decodeKeyMaterial(encoded: string): Buffer {
  if (!BASE64_PATTERN.test(encoded)) {
    throw new KeyConfigurationError('Key material is not valid base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new KeyConfigurationError('Key material is not canonical base64');
  }
  if (bytes.length !== AES_KEY_BYTES) {
    bytes.fill(0);
    throw new KeyConfigurationError('Key material must be exactly 256 bits');
  }
  // A constant key (e.g. all zeros) is a placeholder, never a generated key.
  if (bytes.every((byte) => byte === bytes[0])) {
    bytes.fill(0);
    throw new KeyConfigurationError('Key material is not random');
  }
  return bytes;
}

/**
 * Validates an untrusted keyring document. Error messages name the problem,
 * never the offending value.
 */
export function parseKeyring(input: unknown): Keyring {
  if (!isRecord(input)) throw new KeyConfigurationError('Keyring must be a JSON object');
  if (input.format !== KEYRING_FORMAT) {
    throw new KeyConfigurationError('Keyring has an unknown format');
  }
  if (input.formatVersion !== KEYRING_FORMAT_VERSION) {
    throw new KeyConfigurationError('Keyring format version is not supported');
  }
  if (input.usage !== 'development') {
    throw new KeyConfigurationError('Keyring usage must be "development"');
  }
  if (typeof input.keyId !== 'string' || !KEY_ID_PATTERN.test(input.keyId)) {
    throw new KeyConfigurationError('Keyring key id is invalid');
  }
  if (!Array.isArray(input.versions) || input.versions.length === 0) {
    throw new KeyConfigurationError('Keyring has no key versions');
  }
  if (input.versions.length > MAX_VERSIONS) {
    throw new KeyConfigurationError('Keyring has too many key versions');
  }
  const versions: KeyringVersion[] = [];
  const seen = new Set<number>();
  const materials = new Set<string>();
  for (const raw of input.versions as unknown[]) {
    if (!isRecord(raw)) throw new KeyConfigurationError('Keyring version entry is invalid');
    const { version, status, createdAt, key, retiredAt } = raw;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw new KeyConfigurationError('Keyring version number is invalid');
    }
    if (seen.has(version)) throw new KeyConfigurationError('Keyring version numbers repeat');
    seen.add(version);
    if (status !== 'active' && status !== 'decrypt-only' && status !== 'retired') {
      throw new KeyConfigurationError('Keyring version status is invalid');
    }
    if (!isTimestamp(createdAt)) {
      throw new KeyConfigurationError('Keyring version timestamp is invalid');
    }
    const entry: KeyringVersion = { version, status, createdAt };
    if (status === 'retired') {
      if (key !== undefined) {
        throw new KeyConfigurationError('Retired key versions must not contain key material');
      }
      if (!isTimestamp(retiredAt)) {
        throw new KeyConfigurationError('Retired key version needs a retirement timestamp');
      }
      entry.retiredAt = retiredAt;
    } else {
      if (typeof key !== 'string') {
        throw new KeyConfigurationError('Key version is missing its key material');
      }
      decodeKeyMaterial(key).fill(0);
      if (materials.has(key)) {
        throw new KeyConfigurationError('Key versions must not share key material');
      }
      materials.add(key);
      entry.key = key;
    }
    versions.push(entry);
  }
  const active = versions.filter((entry) => entry.status === 'active');
  const [activeEntry] = active;
  if (active.length !== 1 || !activeEntry) {
    throw new KeyConfigurationError('Keyring must have exactly one active key version');
  }
  if (input.activeVersion !== activeEntry.version) {
    throw new KeyConfigurationError('Keyring active version does not match the active entry');
  }
  const maxVersion = Math.max(...versions.map((entry) => entry.version));
  if (activeEntry.version !== maxVersion) {
    throw new KeyConfigurationError('The active key version must be the newest version');
  }
  return {
    format: KEYRING_FORMAT,
    formatVersion: KEYRING_FORMAT_VERSION,
    usage: 'development',
    keyId: input.keyId,
    activeVersion: activeEntry.version,
    versions: versions.sort((a, b) => a.version - b.version),
  };
}

/** Parses keyring JSON text. JSON syntax errors do not echo the content. */
export function parseKeyringJson(text: string): Keyring {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeyConfigurationError('Keyring is not valid JSON');
  }
  return parseKeyring(value);
}

export function serializeKeyring(keyring: Keyring): string {
  return `${JSON.stringify(keyring, null, 2)}\n`;
}

function newKeyMaterial(): string {
  const bytes = randomBytes(AES_KEY_BYTES);
  try {
    return bytes.toString('base64');
  } finally {
    bytes.fill(0);
  }
}

/** Creates a new keyring with version 1 active. Key material comes from the OS CSPRNG. */
export function generateKeyring(now = new Date()): Keyring {
  return {
    format: KEYRING_FORMAT,
    formatVersion: KEYRING_FORMAT_VERSION,
    usage: 'development',
    keyId: `local-${randomBytes(16).toString('hex')}`,
    activeVersion: 1,
    versions: [
      { version: 1, status: 'active', createdAt: now.toISOString(), key: newKeyMaterial() },
    ],
  };
}

/**
 * Returns a new keyring with a fresh active version; the previous active
 * version becomes decrypt-only. The input is not modified.
 */
export function rotateKeyring(keyring: Keyring, now = new Date()): Keyring {
  const current = parseKeyring(keyring);
  const next = current.activeVersion + 1;
  return {
    ...current,
    activeVersion: next,
    versions: [
      ...current.versions.map((entry) =>
        entry.status === 'active' ? { ...entry, status: 'decrypt-only' as const } : { ...entry },
      ),
      { version: next, status: 'active', createdAt: now.toISOString(), key: newKeyMaterial() },
    ],
  };
}

/**
 * Destroys the material of a decrypt-only version. Refuses while any live
 * envelope still references it: the caller must count references (e.g.
 * `secret_versions.kms_key_version`) after re-wrapping and pass the count.
 */
export function retireKeyVersion(
  keyring: Keyring,
  version: number,
  liveEnvelopeReferences: number,
  now = new Date(),
): Keyring {
  const current = parseKeyring(keyring);
  const entry = current.versions.find((candidate) => candidate.version === version);
  if (!entry) throw new CryptoInputError('Unknown key version');
  if (entry.status === 'active')
    throw new CryptoInputError('The active key version cannot be retired');
  if (entry.status === 'retired') return current;
  if (!Number.isSafeInteger(liveEnvelopeReferences) || liveEnvelopeReferences !== 0) {
    throw new CryptoInputError('Key version is still referenced by live envelopes');
  }
  return {
    ...current,
    versions: current.versions.map((candidate) =>
      candidate.version === version
        ? {
            version: candidate.version,
            status: 'retired' as const,
            createdAt: candidate.createdAt,
            retiredAt: now.toISOString(),
          }
        : { ...candidate },
    ),
  };
}

export function keyringMetadata(keyring: Keyring): KeyMetadata[] {
  return keyring.versions.map((entry) => ({
    providerId: LOCAL_PROVIDER_ID,
    keyId: keyring.keyId,
    keyVersion: entry.version,
    status: entry.status,
    createdAt: entry.createdAt,
  }));
}
