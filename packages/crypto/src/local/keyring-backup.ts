import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { AAD_DOMAINS, encodeAad } from '../aad.js';
import { AES_KEY_BYTES, GCM_NONCE_BYTES, GCM_TAG_BYTES, open, seal } from '../aes-gcm.js';
import { DecryptionError, KeyConfigurationError } from '../errors.js';
import {
  decodeKeyMaterial,
  type Keyring,
  KEYRING_USAGES,
  type KeyringUsage,
  parseKeyring,
  parseKeyringJson,
  serializeKeyring,
} from './keyring.js';
import { readProtectedFile, writeProtectedFile } from './keyring-file.js';

/**
 * Encrypted keyring backups. A backup is sealed with AES-256-GCM under a
 * subkey derived (HKDF-SHA256, random salt per backup) from an independent
 * 256 bit recovery key. The recovery key never touches the database or the
 * keyring file and must be stored apart from both, offline.
 *
 * The header (key id, usage, versions, recovery key id, salt) is readable
 * without the recovery key and is authenticated as associated data, so it
 * cannot be edited without the restore failing.
 */
export const RECOVERY_KEY_FORMAT = 'envvault.recovery-key';
export const KEYRING_BACKUP_FORMAT = 'envvault.keyring-backup';
const FORMAT_VERSION = 1;
const HKDF_INFO = 'envvault/keyring-backup/v1';
const SALT_BYTES = 32;
const RECOVERY_KEY_ID_PATTERN = /^rk-[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface RecoveryKey {
  readonly id: string;
  readonly createdAt: string;
  /** Raw key. Zero it with {@link destroyRecoveryKey} after use. */
  readonly material: Buffer;
}

export interface KeyringBackupHeader {
  format: typeof KEYRING_BACKUP_FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  backupId: string;
  createdAt: string;
  keyId: string;
  usage: KeyringUsage;
  activeVersion: number;
  /** Versions in the backup; `active` and `decrypt-only` ones hold material. */
  versions: { version: number; status: 'active' | 'decrypt-only' | 'retired' }[];
  recoveryKeyId: string;
  algorithm: 'AES-256-GCM';
  kdf: 'HKDF-SHA256';
}

export interface KeyringBackup extends KeyringBackupHeader {
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function recoveryKeyId(material: Buffer): string {
  // A key derived identifier: lets an operator match a key to a backup without revealing it.
  const digest = createHmac('sha256', material).update('envvault/recovery-key-id').digest('hex');
  return `rk-${digest.slice(0, 32)}`;
}

export function generateRecoveryKey(now = new Date()): RecoveryKey {
  const material = randomBytes(AES_KEY_BYTES);
  return { id: recoveryKeyId(material), createdAt: now.toISOString(), material };
}

export function destroyRecoveryKey(key: RecoveryKey): void {
  key.material.fill(0);
}

export function serializeRecoveryKey(key: RecoveryKey): string {
  return `${JSON.stringify(
    {
      format: RECOVERY_KEY_FORMAT,
      formatVersion: FORMAT_VERSION,
      recoveryKeyId: key.id,
      createdAt: key.createdAt,
      key: key.material.toString('base64'),
    },
    null,
    2,
  )}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRecoveryKeyJson(text: string): RecoveryKey {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeyConfigurationError('Recovery key is not valid JSON');
  }
  if (
    !isRecord(value) ||
    value.format !== RECOVERY_KEY_FORMAT ||
    value.formatVersion !== FORMAT_VERSION
  ) {
    throw new KeyConfigurationError('Recovery key has an unknown format');
  }
  if (typeof value.key !== 'string' || typeof value.createdAt !== 'string') {
    throw new KeyConfigurationError('Recovery key is incomplete');
  }
  const material = decodeKeyMaterial(value.key);
  const id = recoveryKeyId(material);
  if (value.recoveryKeyId !== id) {
    material.fill(0);
    throw new KeyConfigurationError('Recovery key does not match its identifier');
  }
  return { id, createdAt: value.createdAt, material };
}

/** Creates the recovery key file; never replaces an existing one. */
export async function writeRecoveryKeyFile(path: string, key: RecoveryKey): Promise<void> {
  await writeProtectedFile(path, serializeRecoveryKey(key), { exclusive: true });
}

export async function readRecoveryKeyFile(path: string): Promise<RecoveryKey> {
  return parseRecoveryKeyJson(await readProtectedFile(path, 'Recovery key file'));
}

function headerAad(header: KeyringBackupHeader, salt: string): Buffer {
  return encodeAad(AAD_DOMAINS.keyringBackup, [
    ['formatVersion', String(header.formatVersion)],
    ['backupId', header.backupId],
    ['createdAt', header.createdAt],
    ['keyId', header.keyId],
    ['usage', header.usage],
    ['activeVersion', String(header.activeVersion)],
    ['versions', header.versions.map((v) => `${String(v.version)}:${v.status}`).join(',')],
    ['recoveryKeyId', header.recoveryKeyId],
    ['algorithm', header.algorithm],
    ['kdf', header.kdf],
    ['salt', salt],
  ]);
}

function subkey(recovery: RecoveryKey, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', recovery.material, salt, HKDF_INFO, AES_KEY_BYTES));
}

function headerOf(keyring: Keyring, recovery: RecoveryKey, now: Date): KeyringBackupHeader {
  return {
    format: KEYRING_BACKUP_FORMAT,
    formatVersion: FORMAT_VERSION,
    backupId: randomUUID(),
    createdAt: now.toISOString(),
    keyId: keyring.keyId,
    usage: keyring.usage,
    activeVersion: keyring.activeVersion,
    versions: keyring.versions.map((v) => ({ version: v.version, status: v.status })),
    recoveryKeyId: recovery.id,
    algorithm: 'AES-256-GCM',
    kdf: 'HKDF-SHA256',
  };
}

/** Seals a keyring under the recovery key. The keyring is validated first. */
export function createKeyringBackup(
  keyring: Keyring,
  recovery: RecoveryKey,
  now = new Date(),
): KeyringBackup {
  const current = parseKeyring(keyring);
  const header = headerOf(current, recovery, now);
  const salt = randomBytes(SALT_BYTES);
  const key = subkey(recovery, salt);
  const plaintext = Buffer.from(serializeKeyring(current), 'utf8');
  try {
    const sealed = seal(key, plaintext, headerAad(header, salt.toString('base64')));
    return {
      ...header,
      salt: salt.toString('base64'),
      nonce: sealed.nonce.toString('base64'),
      ciphertext: sealed.ciphertext.toString('base64'),
      tag: sealed.tag.toString('base64'),
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

function base64Field(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new KeyConfigurationError('Backup is malformed');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    throw new KeyConfigurationError('Backup is malformed');
  }
  return bytes;
}

/** Validates the readable part of a backup. Needs no key and reveals no key material. */
export function parseKeyringBackup(input: unknown): KeyringBackup {
  if (!isRecord(input) || input.format !== KEYRING_BACKUP_FORMAT) {
    throw new KeyConfigurationError('Not a keyring backup');
  }
  if (input.formatVersion !== FORMAT_VERSION) {
    throw new KeyConfigurationError('Backup format version is not supported');
  }
  const versions = input.versions;
  if (
    typeof input.backupId !== 'string' ||
    !UUID_PATTERN.test(input.backupId) ||
    typeof input.createdAt !== 'string' ||
    Number.isNaN(Date.parse(input.createdAt)) ||
    typeof input.keyId !== 'string' ||
    !(KEYRING_USAGES as readonly unknown[]).includes(input.usage) ||
    typeof input.activeVersion !== 'number' ||
    typeof input.recoveryKeyId !== 'string' ||
    !RECOVERY_KEY_ID_PATTERN.test(input.recoveryKeyId) ||
    input.algorithm !== 'AES-256-GCM' ||
    input.kdf !== 'HKDF-SHA256' ||
    !Array.isArray(versions) ||
    !versions.every(
      (v) =>
        isRecord(v) &&
        typeof v.version === 'number' &&
        (v.status === 'active' || v.status === 'decrypt-only' || v.status === 'retired'),
    )
  ) {
    throw new KeyConfigurationError('Backup header is malformed');
  }
  base64Field(input.salt, SALT_BYTES);
  base64Field(input.nonce, GCM_NONCE_BYTES);
  base64Field(input.tag, GCM_TAG_BYTES);
  base64Field(input.ciphertext);
  return input as unknown as KeyringBackup;
}

export function parseKeyringBackupJson(text: string): KeyringBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeyConfigurationError('Backup is not valid JSON');
  }
  return parseKeyringBackup(value);
}

/**
 * Decrypts and verifies a backup: the tag authenticates content and header,
 * the keyring must pass full validation, and it must agree with the header.
 * A wrong recovery key and a tampered backup both fail with DecryptionError.
 */
export function openKeyringBackup(input: unknown, recovery: RecoveryKey): Keyring {
  const backup = parseKeyringBackup(input);
  if (backup.recoveryKeyId !== recovery.id) {
    throw new KeyConfigurationError('This backup was sealed with a different recovery key');
  }
  const salt = base64Field(backup.salt, SALT_BYTES);
  const key = subkey(recovery, salt);
  let plaintext: Buffer | undefined;
  try {
    plaintext = open(
      key,
      {
        nonce: base64Field(backup.nonce, GCM_NONCE_BYTES),
        ciphertext: base64Field(backup.ciphertext),
        tag: base64Field(backup.tag, GCM_TAG_BYTES),
      },
      headerAad(backup, backup.salt),
    );
    const keyring = parseKeyringJson(plaintext.toString('utf8'));
    const listed = keyring.versions.map((v) => `${String(v.version)}:${v.status}`).join(',');
    const declared = backup.versions.map((v) => `${String(v.version)}:${v.status}`).join(',');
    if (
      keyring.keyId !== backup.keyId ||
      keyring.usage !== backup.usage ||
      keyring.activeVersion !== backup.activeVersion ||
      listed !== declared
    ) {
      throw new DecryptionError();
    }
    return keyring;
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

export function serializeKeyringBackup(backup: KeyringBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/** Writes a new backup file; never replaces an existing one. */
export async function writeKeyringBackupFile(path: string, backup: KeyringBackup): Promise<void> {
  await writeProtectedFile(path, serializeKeyringBackup(backup), { exclusive: true });
}

export async function readKeyringBackupFile(path: string): Promise<KeyringBackup> {
  return parseKeyringBackupJson(await readProtectedFile(path, 'Backup file'));
}

/** Versions with key material in the backup (what it can still decrypt). */
export function backupUsableVersions(backup: KeyringBackupHeader): number[] {
  return backup.versions.filter((v) => v.status !== 'retired').map((v) => v.version);
}
