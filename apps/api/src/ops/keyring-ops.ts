import { resolve, sep } from 'node:path';
import {
  backupUsableVersions,
  createKeyringBackup,
  destroyRecoveryKey,
  generateKeyring,
  generateRecoveryKey,
  type Keyring,
  keyringFileExists,
  type KeyringUsage,
  openKeyringBackup,
  readKeyringBackupFile,
  readKeyringFile,
  readRecoveryKeyFile,
  writeKeyringBackupFile,
  writeKeyringFile,
  writeProtectedFile,
  writeRecoveryKeyFile,
  serializeKeyring,
} from '@envvault/crypto';
import { createRepositories } from '@envvault/database';
import { type OpsContext, OpsError } from './context.js';

const WEB_SERVED_SEGMENTS = new Set(['public', '.next', 'static', 'www']);

function absolute(path: string | undefined, flag: string): string {
  if (!path) throw new OpsError(`Missing ${flag} <path>`, 2);
  const resolved = resolve(path);
  if (resolved.split(sep).some((segment) => WEB_SERVED_SEGMENTS.has(segment))) {
    throw new OpsError('Refusing to place key material inside a web served directory');
  }
  return resolved;
}

/**
 * Creates a new keyring (usage `self-managed` by default) for a production host. Refuses to
 * replace an existing file: that would destroy the keys it holds.
 */
export async function keysInit(
  ops: OpsContext,
  options: { out: string | undefined; usage: KeyringUsage },
): Promise<number> {
  const path = absolute(options.out, '--out');
  if (await keyringFileExists(path)) {
    throw new OpsError(`A file already exists at ${path}. Refusing to overwrite it.`);
  }
  const keyring = generateKeyring(new Date(), options.usage);
  await writeProtectedFile(path, serializeKeyring(keyring), { exclusive: true });
  ops.io.out(`Created ${options.usage} keyring ${keyring.keyId} (version 1 active) at ${path}`);
  ops.io.out('Next: create a recovery key and a backup before storing any secret:');
  ops.io.out('  pnpm ops keyring:recovery-key --out <offline path>');
  ops.io.out(
    `  pnpm ops keyring:backup --keyring-file ${path} --recovery-key-file <path> --out <path>`,
  );
  return 0;
}

/** Writes a new recovery key file. Prints its identifier, never the key. */
export async function recoveryKeyGenerate(
  ops: OpsContext,
  out: string | undefined,
): Promise<number> {
  const path = absolute(out, '--out');
  const key = generateRecoveryKey();
  try {
    await writeRecoveryKeyFile(path, key);
  } finally {
    destroyRecoveryKey(key);
  }
  ops.io.out(`Created recovery key ${key.id} at ${path} (mode 0600).`);
  ops.io.out('Move it off this host now: an offline password manager entry, an encrypted USB');
  ops.io.out('drive or a printed copy in a safe. Never store it next to the keyring, in Git or');
  ops.io.out('in the database. Without it, keyring backups cannot be restored.');
  return 0;
}

async function liveKeyring(
  ops: OpsContext,
  keyringFile: string | undefined,
): Promise<{ keyring: Keyring; path: string }> {
  const path = keyringFile ? absolute(keyringFile, '--keyring-file') : ops.keyringPath();
  return { keyring: await readKeyringFile(path), path };
}

/** Seals the keyring under the recovery key into a new versioned backup file. */
export async function keyringBackup(
  ops: OpsContext,
  options: {
    recoveryKeyFile: string | undefined;
    out: string | undefined;
    keyringFile: string | undefined;
    record: boolean;
  },
): Promise<number> {
  const out = absolute(options.out, '--out');
  const recovery = await readRecoveryKeyFile(
    absolute(options.recoveryKeyFile, '--recovery-key-file'),
  );
  const { keyring } = await liveKeyring(ops, options.keyringFile);
  let backupId: string;
  try {
    const backup = createKeyringBackup(keyring, recovery);
    // Proves the file can be restored before anyone relies on it.
    openKeyringBackup(backup, recovery);
    await writeKeyringBackupFile(out, backup);
    backupId = backup.backupId;
  } finally {
    destroyRecoveryKey(recovery);
  }
  ops.io.out(
    `Backup ${backupId} of ${keyring.keyId} (versions ${keyring.versions.map((v) => `v${String(v.version)} ${v.status}`).join(', ')})`,
  );
  ops.io.out(`written to ${out} and verified. Store it apart from the recovery key.`);
  if (options.record) {
    try {
      await createRepositories(ops.db).audit.appendSystem({
        action: 'encryption.keyring_backed_up',
        outcome: 'SUCCESS',
        resourceType: 'encryption_key',
        metadata: {
          keyId: keyring.keyId,
          backupId,
          recoveryKeyId: recovery.id,
          versions: keyring.versions.map((v) => String(v.version)),
        },
      });
    } catch {
      ops.io.err(
        'Warning: the backup was written but the event could not be recorded in the audit log.',
      );
    }
  }
  return 0;
}

/**
 * Opens a backup with the recovery key and checks it holds material for
 * every key version the database references. Prints versions and counts.
 */
export async function keyringVerifyBackup(
  ops: OpsContext,
  options: {
    backup: string | undefined;
    recoveryKeyFile: string | undefined;
    againstDatabase: boolean;
  },
): Promise<number> {
  const file = await readKeyringBackupFile(absolute(options.backup, '--backup'));
  const recovery = await readRecoveryKeyFile(
    absolute(options.recoveryKeyFile, '--recovery-key-file'),
  );
  let keyring: Keyring;
  try {
    keyring = openKeyringBackup(file, recovery);
  } finally {
    destroyRecoveryKey(recovery);
  }
  ops.io.out(
    `Backup ${file.backupId} of ${keyring.keyId}, taken ${file.createdAt}: integrity verified.`,
  );
  ops.io.out(
    `  usable versions: ${backupUsableVersions(file)
      .map((v) => `v${String(v)}`)
      .join(', ')}`,
  );
  if (!options.againstDatabase) return 0;
  const counts = await createRepositories(ops.db).keyMaintenance.referenceCounts();
  const usable = new Set(backupUsableVersions(file).map(String));
  let missing = 0;
  for (const c of counts) {
    if (c.kmsKeyRef !== keyring.keyId) continue;
    const covered = c.kmsKeyVersion !== null && usable.has(c.kmsKeyVersion);
    ops.io.out(
      `  v${c.kmsKeyVersion ?? '?'}: ${String(c.versions)} secret versions ${covered ? 'covered' : 'NOT COVERED'}`,
    );
    if (!covered) missing += c.versions;
  }
  if (missing > 0) {
    ops.io.err(
      `${String(missing)} stored secret versions could not be decrypted with this backup.`,
    );
    return 1;
  }
  return 0;
}

/**
 * Restores a backup to a keyring file. Intended for an isolated environment:
 * an existing file is only replaced when its key id is confirmed.
 */
export async function keyringRestore(
  ops: OpsContext,
  options: {
    backup: string | undefined;
    recoveryKeyFile: string | undefined;
    to: string | undefined;
    overwrite: string | undefined;
  },
): Promise<number> {
  const to = absolute(options.to, '--to');
  const file = await readKeyringBackupFile(absolute(options.backup, '--backup'));
  const recovery = await readRecoveryKeyFile(
    absolute(options.recoveryKeyFile, '--recovery-key-file'),
  );
  let keyring: Keyring;
  try {
    keyring = openKeyringBackup(file, recovery);
  } finally {
    destroyRecoveryKey(recovery);
  }
  if (await keyringFileExists(to)) {
    let existing: string;
    try {
      existing = (await readKeyringFile(to)).keyId;
    } catch {
      throw new OpsError(`A file exists at ${to} and is not a usable keyring. Move it away first.`);
    }
    if (options.overwrite !== existing) {
      throw new OpsError(
        `A keyring (${existing}) exists at ${to}. Replacing it destroys its keys; run again with --overwrite ${existing}`,
        2,
      );
    }
    await writeKeyringFile(to, keyring);
  } else {
    await writeProtectedFile(to, serializeKeyring(keyring), { exclusive: true });
  }
  ops.io.out(`Restored ${keyring.keyId} from backup ${file.backupId} to ${to}.`);
  ops.io.out(
    'Point ENCRYPTION_KEYRING_FILE at it, then run pnpm ops keys:verify before serving traffic.',
  );
  return 0;
}
