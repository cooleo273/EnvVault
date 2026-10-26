import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecryptionError, KeyConfigurationError } from '../errors.js';
import { SecretCipher } from '../secret-cipher.js';
import { syntheticContext } from '../test-helpers.js';
import { generateKeyring, rotateKeyring, serializeKeyring } from './keyring.js';
import {
  createKeyringBackup,
  generateRecoveryKey,
  openKeyringBackup,
  parseRecoveryKeyJson,
  readKeyringBackupFile,
  readRecoveryKeyFile,
  serializeKeyringBackup,
  serializeRecoveryKey,
  writeKeyringBackupFile,
  writeRecoveryKeyFile,
} from './keyring-backup.js';
import { enforcesPosixPermissions } from './keyring-file.js';
import { LocalKeyProvider } from './local-provider.js';

describe('keyring backups', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'envvault-backup-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('restores a keyring that still decrypts data sealed before the backup', async () => {
    const keyring = rotateKeyring(generateKeyring());
    const cipher = new SecretCipher(new LocalKeyProvider(keyring, { nodeEnv: 'test' }));
    const context = syntheticContext();
    const envelope = await cipher.encryptSecret('synthetic-backup-value', context);

    const recovery = generateRecoveryKey();
    const backup = createKeyringBackup(keyring, recovery);
    const restored = openKeyringBackup(JSON.parse(serializeKeyringBackup(backup)), recovery);
    expect(restored).toEqual(keyring);
    const after = new SecretCipher(new LocalKeyProvider(restored, { nodeEnv: 'test' }));
    expect(await after.decryptSecret(envelope, context)).toBe('synthetic-backup-value');
  });

  it('holds no key material in readable form', () => {
    const keyring = generateKeyring();
    const recovery = generateRecoveryKey();
    const text = serializeKeyringBackup(createKeyringBackup(keyring, recovery));
    for (const entry of keyring.versions) expect(text).not.toContain(entry.key);
    expect(text).not.toContain(recovery.material.toString('base64'));
    expect(text).toContain(keyring.keyId);
  });

  it('fails closed on a tampered ciphertext, tag or header', () => {
    const recovery = generateRecoveryKey();
    const backup = createKeyringBackup(rotateKeyring(generateKeyring()), recovery);
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return bytes.toString('base64');
    };
    expect(() =>
      openKeyringBackup({ ...backup, ciphertext: flip(backup.ciphertext) }, recovery),
    ).toThrow(DecryptionError);
    expect(() => openKeyringBackup({ ...backup, tag: flip(backup.tag) }, recovery)).toThrow(
      DecryptionError,
    );
    expect(() =>
      openKeyringBackup({ ...backup, createdAt: new Date(0).toISOString() }, recovery),
    ).toThrow(DecryptionError);
    expect(() =>
      openKeyringBackup(
        { ...backup, versions: backup.versions.filter((v) => v.status === 'active') },
        recovery,
      ),
    ).toThrow(DecryptionError);
  });

  it('refuses a different recovery key, even with a forged identifier', () => {
    const backup = createKeyringBackup(generateKeyring(), generateRecoveryKey());
    const other = generateRecoveryKey();
    expect(() => openKeyringBackup(backup, other)).toThrow('different recovery key');
    expect(() => openKeyringBackup({ ...backup, recoveryKeyId: other.id }, other)).toThrow(
      DecryptionError,
    );
  });

  it('rejects recovery keys whose identifier does not match the key', () => {
    const recovery = generateRecoveryKey();
    const json = JSON.parse(serializeRecoveryKey(recovery)) as Record<string, unknown>;
    expect(parseRecoveryKeyJson(JSON.stringify(json)).id).toBe(recovery.id);
    expect(() =>
      parseRecoveryKeyJson(JSON.stringify({ ...json, recoveryKeyId: generateRecoveryKey().id })),
    ).toThrow(KeyConfigurationError);
  });

  it('writes recovery keys and backups as new owner only files, never over existing ones', async () => {
    const recovery = generateRecoveryKey();
    const keyPath = join(directory, 'recovery.json');
    await writeRecoveryKeyFile(keyPath, recovery);
    await expect(writeRecoveryKeyFile(keyPath, generateRecoveryKey())).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect((await readRecoveryKeyFile(keyPath)).id).toBe(recovery.id);

    const backupPath = join(directory, 'backup.json');
    const backup = createKeyringBackup(generateKeyring(), recovery);
    await writeKeyringBackupFile(backupPath, backup);
    await expect(writeKeyringBackupFile(backupPath, backup)).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect((await readKeyringBackupFile(backupPath)).backupId).toBe(backup.backupId);
    if (enforcesPosixPermissions()) {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a recovery key file readable by others', async () => {
    if (!enforcesPosixPermissions()) return;
    const path = join(directory, 'open.json');
    await writeFile(path, serializeRecoveryKey(generateRecoveryKey()), { mode: 0o644 });
    await expect(readRecoveryKeyFile(path)).rejects.toThrow('too open');
  });

  it('refuses to back up an invalid keyring', () => {
    const broken = {
      ...JSON.parse(serializeKeyring(generateKeyring())),
      activeVersion: 9,
    } as never;
    expect(() => createKeyringBackup(broken, generateRecoveryKey())).toThrow(KeyConfigurationError);
  });
});
