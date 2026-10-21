import {
  isCryptoError,
  type Keyring,
  keyringMetadata,
  openKeyringBackup,
  readKeyringBackupFile,
  readRecoveryKeyFile,
  destroyRecoveryKey,
  retireKeyVersion,
  rotateKeyring,
  SecretCipher,
  type SecretEncryptionContext,
  type SecretEnvelope,
  writeKeyringFile,
} from '@envvault/crypto';
import { createRepositories, type EnvelopeQuery, type StoredEnvelopeRow } from '@envvault/database';
import { type OpsContext, OpsError } from './context.js';

const PROVIDER = 'local';
const MAX_LISTED_FAILURES = 50;

function envelopeOf(row: StoredEnvelopeRow): SecretEnvelope {
  if (row.kmsKeyVersion === null || !/^[1-9]\d*$/.test(row.kmsKeyVersion)) {
    throw new OpsError('row has no key version');
  }
  return {
    formatVersion: row.envelopeVersion,
    algorithm: row.algorithm === 'AES_256_GCM' ? 'AES-256-GCM' : row.algorithm,
    providerId: row.kmsProvider,
    keyId: row.kmsKeyRef,
    keyVersion: Number(row.kmsKeyVersion),
    wrappedKey: row.encryptedDataKey,
    nonce: row.iv,
    ciphertext: row.ciphertext,
    tag: row.authTag,
  };
}

function contextOf(row: StoredEnvelopeRow): SecretEncryptionContext {
  return {
    workspaceId: row.workspaceId.toLowerCase(),
    projectId: row.projectId.toLowerCase(),
    environmentId: row.environmentId.toLowerCase(),
    secretId: row.secretId.toLowerCase(),
    secretVersionId: row.id.toLowerCase(),
  };
}

function failureCode(error: unknown): string {
  if (isCryptoError(error)) return error.code;
  if (error instanceof OpsError) return 'MALFORMED_ROW';
  return 'UNKNOWN';
}

async function recordEvent(
  ops: OpsContext,
  action: string,
  outcome: 'SUCCESS' | 'FAILURE',
  keyId: string,
  metadata: Record<string, string | number | boolean | string[] | null>,
): Promise<void> {
  try {
    await createRepositories(ops.db).audit.appendSystem({
      action,
      outcome,
      resourceType: 'encryption_key',
      metadata: { keyId, ...metadata },
    });
  } catch {
    // The operation already happened; say so instead of hiding it.
    ops.io.err(`Warning: the ${action} event could not be recorded in the audit log.`);
  }
}

/** Versions per key version, and which `decrypt-only` versions could be retired. */
export async function keysStatus(ops: OpsContext): Promise<number> {
  const keyring = await ops.keyring();
  const counts = await createRepositories(ops.db).keyMaintenance.referenceCounts();
  ops.io.out(
    `Keyring ${keyring.keyId} (${keyring.usage}), active version ${String(keyring.activeVersion)}`,
  );
  for (const entry of keyringMetadata(keyring)) {
    const references = counts
      .filter(
        (c) =>
          c.kmsProvider === PROVIDER &&
          c.kmsKeyRef === keyring.keyId &&
          c.kmsKeyVersion === String(entry.keyVersion),
      )
      .reduce((sum, c) => sum + c.versions, 0);
    const note =
      entry.status === 'decrypt-only' && references === 0
        ? '  (no references: can be retired)'
        : '';
    ops.io.out(
      `  v${String(entry.keyVersion)}  ${entry.status.padEnd(12)}  ${String(references).padStart(8)} secret versions${note}`,
    );
  }
  const foreign = counts.filter((c) => c.kmsProvider !== PROVIDER || c.kmsKeyRef !== keyring.keyId);
  for (const c of foreign) {
    ops.io.out(
      `  other key ${c.kmsProvider}/${c.kmsKeyRef} v${c.kmsKeyVersion ?? '?'}: ${String(c.versions)} secret versions (not decryptable with this keyring)`,
    );
  }
  const unversioned = counts
    .filter((c) => c.kmsKeyVersion === null)
    .reduce((sum, c) => sum + c.versions, 0);
  const proposals = await createRepositories(ops.db).keyMaintenance.changeRequestEnvelopes();
  if (proposals > 0) {
    ops.io.out(
      `  ${String(proposals)} change request values are encrypted (key version not recorded)`,
    );
  }
  if (unversioned > 0) {
    ops.io.out(`  ${String(unversioned)} secret versions have no recorded key version`);
  }
  return foreign.length > 0 ? 3 : 0;
}

/** Adds a new active key version. Existing data keep their versions until rewrapped. */
export async function keysRotate(ops: OpsContext, confirm: string | undefined): Promise<number> {
  const path = ops.keyringPath();
  const keyring = await ops.keyring();
  if (confirm !== keyring.keyId) {
    throw new OpsError(
      `Rotation adds a new active version to ${keyring.keyId}. Run again with --confirm ${keyring.keyId}`,
      2,
    );
  }
  const rotated = rotateKeyring(keyring);
  // Persisted before anything uses it: a key must never wrap data before it is durable.
  await writeKeyringFile(path, rotated);
  ops.io.out(
    `Rotated ${rotated.keyId}: version ${String(rotated.activeVersion)} is active, version ${String(keyring.activeVersion)} is now "decrypt-only".`,
  );
  ops.io.out('Next: back up the keyring (pnpm ops keyring:backup), restart every API instance,');
  ops.io.out('then rewrap existing data keys (pnpm ops keys:rewrap --dry-run first).');
  await recordEvent(ops, 'encryption.key_rotated', 'SUCCESS', rotated.keyId, {
    fromVersion: keyring.activeVersion,
    toVersion: rotated.activeVersion,
  });
  return 0;
}

export interface RewrapOptions {
  dryRun: boolean;
  batchSize: number;
  maxFailures?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Called after each row, for progress output. */
  onItem?: (report: Readonly<RewrapReport>) => void;
}

export interface RewrapReport {
  pending: number;
  processed: number;
  rewrapped: number;
  skippedConcurrent: number;
  failed: { id: string; code: string }[];
  interrupted: boolean;
}

/**
 * Rewraps data keys still on older key versions onto the active version.
 * Each row is one compare and set update of the wrapped key only, so a crash
 * leaves every row either old or new, and a rerun picks up what is left.
 */
export async function rewrap(ops: OpsContext, options: RewrapOptions): Promise<RewrapReport> {
  const keyring = await ops.keyring();
  const repos = createRepositories(ops.db);
  const query: EnvelopeQuery = {
    kmsProvider: PROVIDER,
    kmsKeyRef: keyring.keyId,
    excludeKeyVersion: String(keyring.activeVersion),
  };
  const pending = await repos.keyMaintenance.count(query);
  const report: RewrapReport = {
    pending,
    processed: 0,
    rewrapped: 0,
    skippedConcurrent: 0,
    failed: [],
    interrupted: false,
  };
  if (options.dryRun || pending === 0) return report;

  const provider = ops.provider(keyring);
  const cipher = new SecretCipher(provider);
  const active = await provider.getActiveKeyVersion();
  await recordEvent(ops, 'encryption.rewrap_started', 'SUCCESS', keyring.keyId, {
    activeVersion: active.keyVersion,
    pending,
  });
  let after: string | undefined;
  try {
    for (;;) {
      if (options.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      const rows = await repos.keyMaintenance.page(query, options.batchSize, after);
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.id;
        if (options.signal?.aborted) {
          report.interrupted = true;
          break;
        }
        report.processed += 1;
        try {
          const result = await cipher.rewrapSecret(envelopeOf(row), contextOf(row));
          if (!result.changed) continue;
          const stored = await repos.keyMaintenance.replaceWrappedKey(
            row.id,
            { kmsKeyVersion: row.kmsKeyVersion, encryptedDataKey: row.encryptedDataKey },
            {
              kmsKeyVersion: String(result.envelope.keyVersion),
              encryptedDataKey: result.envelope.wrappedKey,
            },
          );
          if (stored) report.rewrapped += 1;
          else report.skippedConcurrent += 1;
        } catch (error) {
          report.failed.push({ id: row.id, code: failureCode(error) });
          if (options.maxFailures !== undefined && report.failed.length >= options.maxFailures) {
            report.interrupted = true;
            break;
          }
        } finally {
          options.onItem?.(report);
        }
      }
      if (report.interrupted) break;
    }
  } finally {
    provider.destroy();
    await recordEvent(
      ops,
      report.interrupted ? 'encryption.rewrap_interrupted' : 'encryption.rewrap_completed',
      report.failed.length > 0 ? 'FAILURE' : 'SUCCESS',
      keyring.keyId,
      {
        activeVersion: active.keyVersion,
        processed: report.processed,
        rewrapped: report.rewrapped,
        skippedConcurrent: report.skippedConcurrent,
        failed: report.failed.length,
        failedIds: report.failed.slice(0, MAX_LISTED_FAILURES).map((f) => f.id),
      },
    );
  }
  return report;
}

export function printRewrap(ops: OpsContext, report: RewrapReport, dryRun: boolean): number {
  if (dryRun) {
    ops.io.out(
      `Dry run: ${String(report.pending)} secret versions would be rewrapped. Nothing changed.`,
    );
    return 0;
  }
  ops.io.out(
    `Rewrapped ${String(report.rewrapped)} of ${String(report.pending)} pending; ${String(report.skippedConcurrent)} changed concurrently, ${String(report.failed.length)} failed.`,
  );
  for (const failure of report.failed.slice(0, MAX_LISTED_FAILURES)) {
    ops.io.err(`  failed ${failure.id}: ${failure.code}`);
  }
  if (report.interrupted) ops.io.err('Interrupted. Run the command again to continue.');
  return report.failed.length > 0 || report.interrupted ? 1 : 0;
}

export interface VerifyReport {
  checked: number;
  failed: { id: string; code: string }[];
}

/** Authenticates stored envelopes (all, or one key version) without producing values. */
export async function verifyEnvelopes(
  ops: OpsContext,
  options: { keyVersion?: number | undefined; limit?: number | undefined; batchSize: number },
): Promise<VerifyReport> {
  const keyring = await ops.keyring();
  const provider = ops.provider(keyring);
  const cipher = new SecretCipher(provider);
  const repos = createRepositories(ops.db);
  const query: EnvelopeQuery = {
    kmsProvider: PROVIDER,
    kmsKeyRef: keyring.keyId,
    ...(options.keyVersion !== undefined ? { keyVersion: String(options.keyVersion) } : {}),
  };
  const report: VerifyReport = { checked: 0, failed: [] };
  let after: string | undefined;
  try {
    while (options.limit === undefined || report.checked < options.limit) {
      const rows = await repos.keyMaintenance.page(query, options.batchSize, after);
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.id;
        if (options.limit !== undefined && report.checked >= options.limit) break;
        report.checked += 1;
        try {
          await cipher.verifySecret(envelopeOf(row), contextOf(row));
        } catch (error) {
          report.failed.push({ id: row.id, code: failureCode(error) });
        }
      }
    }
  } finally {
    provider.destroy();
  }
  return report;
}

/**
 * Destroys the material of a `decrypt-only` version. Refuses while any stored
 * version references it, and unless a backup that holds the same material
 * opens with the given recovery key: database backups taken before the
 * rewrap still need that version.
 */
export async function keysRetire(
  ops: OpsContext,
  options: {
    version: number;
    confirm: string | undefined;
    backupPath: string | undefined;
    recoveryKeyPath: string | undefined;
  },
): Promise<number> {
  const path = ops.keyringPath();
  const keyring = await ops.keyring();
  const entry = keyring.versions.find((v) => v.version === options.version);
  if (!entry) throw new OpsError(`Version ${String(options.version)} is not in the keyring`);
  if (entry.status !== 'decrypt-only') {
    throw new OpsError(
      `Only "decrypt-only" versions can be retired (v${String(options.version)} is ${entry.status})`,
    );
  }
  if (!options.backupPath || !options.recoveryKeyPath) {
    throw new OpsError(
      'Retiring needs --backup and --recovery-key-file of a verified keyring backup',
      2,
    );
  }
  const references = await createRepositories(ops.db).keyMaintenance.count({
    kmsProvider: PROVIDER,
    kmsKeyRef: keyring.keyId,
    keyVersion: String(options.version),
  });
  const proposals = await createRepositories(ops.db).keyMaintenance.changeRequestEnvelopes();
  if (proposals !== 0) {
    throw new OpsError(
      `${String(proposals)} change request values are encrypted without a recorded key version; retiring could make them unreadable.`,
    );
  }
  if (references !== 0) {
    throw new OpsError(
      `${String(references)} secret versions still use v${String(options.version)}. Rewrap first (pnpm ops keys:rewrap).`,
    );
  }
  assertBackupHolds(
    keyring,
    options.version,
    await openBackup(options.backupPath, options.recoveryKeyPath),
  );
  if (options.confirm !== keyring.keyId) {
    throw new OpsError(
      `Retiring destroys v${String(options.version)} of ${keyring.keyId} in this keyring. Run again with --confirm ${keyring.keyId}`,
      2,
    );
  }
  const retired = retireKeyVersion(keyring, options.version, references);
  await writeKeyringFile(path, retired);
  ops.io.out(
    `Retired v${String(options.version)} of ${keyring.keyId}. The backup still holds its material.`,
  );
  ops.io.out('Keep that backup for as long as database backups made before the rewrap are kept.');
  await recordEvent(ops, 'encryption.key_retired', 'SUCCESS', keyring.keyId, {
    version: options.version,
  });
  return 0;
}

async function openBackup(backupPath: string, recoveryKeyPath: string): Promise<Keyring> {
  const recovery = await readRecoveryKeyFile(recoveryKeyPath);
  try {
    return openKeyringBackup(await readKeyringBackupFile(backupPath), recovery);
  } finally {
    destroyRecoveryKey(recovery);
  }
}

function assertBackupHolds(live: Keyring, version: number, backup: Keyring): void {
  const liveEntry = live.versions.find((v) => v.version === version);
  const backupEntry = backup.versions.find((v) => v.version === version);
  if (
    backup.keyId !== live.keyId ||
    !liveEntry?.key ||
    !backupEntry?.key ||
    backupEntry.key !== liveEntry.key
  ) {
    throw new OpsError(`The backup does not hold v${String(version)} of ${live.keyId}`);
  }
}
