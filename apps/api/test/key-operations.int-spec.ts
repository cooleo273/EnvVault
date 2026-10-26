import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeyringBackup,
  type DataKey,
  type DataKeyContext,
  generateKeyring,
  generateRecoveryKey,
  type KeyManagementProvider,
  LocalKeyProvider,
  readKeyringFile,
  type WrappedDataKey,
  writeKeyringBackupFile,
  writeKeyringFile,
  writeRecoveryKeyFile,
} from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { revealedSecretSchema } from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import { OpsContext, OpsError } from '../src/ops/context.js';
import { keyringVerifyBackup } from '../src/ops/keyring-ops.js';
import { keysRetire, keysRotate, keysStatus, rewrap, verifyEnvelopes } from '../src/ops/keys.js';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const VALUES = ['synthetic-rotation-a-11', 'synthetic-rotation-b-22', 'synthetic-rotation-c-33'];

/**
 * Lets the running API pick up a rotated keyring without a restart, the way
 * restarting every API instance would in a deployment.
 */
class SwitchableProvider implements KeyManagementProvider {
  readonly providerId = 'local';
  constructor(public current: LocalKeyProvider) {}
  validateKeyConfiguration() {
    return this.current.validateKeyConfiguration();
  }
  getActiveKeyVersion() {
    return this.current.getActiveKeyVersion();
  }
  listKeyMetadata() {
    return this.current.listKeyMetadata();
  }
  generateDataKey(context: DataKeyContext) {
    return this.current.generateDataKey(context);
  }
  wrapDataKey(dataKey: DataKey, context: DataKeyContext) {
    return this.current.wrapDataKey(dataKey, context);
  }
  unwrapDataKey(wrapped: WrappedDataKey, context: DataKeyContext) {
    return this.current.unwrapDataKey(wrapped, context);
  }
  rotateWrappingKey() {
    return this.current.rotateWrappingKey();
  }
}

let h: Harness;
let api: ReturnType<typeof client>;
let directory: string;
let keyringPath: string;
let provider: SwitchableProvider;
const lines: string[] = [];

function ops(): OpsContext {
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENCRYPTION_PROVIDER: 'local',
    ENCRYPTION_KEYRING_FILE: keyringPath,
    ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED: false,
  } as unknown as Env;
  return new OpsContext(
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    () => env,
    h.db,
  );
}

async function reloadApi(): Promise<void> {
  provider.current = new LocalKeyProvider(await readKeyringFile(keyringPath), { nodeEnv: 'test' });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'envvault-keys-'));
  keyringPath = join(directory, 'keyring.json');
  await writeKeyringFile(keyringPath, generateKeyring());
  provider = new SwitchableProvider(
    new LocalKeyProvider(await readKeyringFile(keyringPath), { nodeEnv: 'test' }),
  );
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  api = client(h);
});
afterAll(async () => {
  await h.stop();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAllTables(h.db);
  await writeKeyringFile(keyringPath, generateKeyring());
  await reloadApi();
  lines.length = 0;
});

async function seed() {
  const w = await api.world('keys');
  const ids: string[] = [];
  for (const [index, value] of VALUES.entries()) {
    const created = await api.createSecret(w.owner, w.secrets(w.dev), {
      key: `ROTATION_${String(index)}`,
      value,
    });
    ids.push(created.id);
  }
  return { w, ids };
}

async function versionsOn(version: string): Promise<number> {
  return h.db.secretVersion.count({ where: { kmsKeyVersion: version } });
}

describe('key rotation and rewrapping', () => {
  it('rotates only with confirmation, rewraps every data key and keeps values readable', async () => {
    const { w, ids } = await seed();
    const keyId = (await readKeyringFile(keyringPath)).keyId;
    await expect(keysRotate(ops(), 'local-wrong')).rejects.toThrow(OpsError);
    expect((await readKeyringFile(keyringPath)).activeVersion).toBe(1);

    expect(await keysRotate(ops(), keyId)).toBe(0);
    await reloadApi();
    expect((await readKeyringFile(keyringPath)).activeVersion).toBe(2);

    const before = await h.db.secretVersion.findMany({ orderBy: { id: 'asc' } });
    const dry = await rewrap(ops(), { dryRun: true, batchSize: 2 });
    expect(dry).toMatchObject({ pending: 3, rewrapped: 0 });
    expect(await versionsOn('1')).toBe(3);

    const report = await rewrap(ops(), { dryRun: false, batchSize: 2 });
    expect(report).toMatchObject({ pending: 3, rewrapped: 3, failed: [], interrupted: false });
    expect(await versionsOn('2')).toBe(3);
    const after = await h.db.secretVersion.findMany({ orderBy: { id: 'asc' } });
    for (const [index, row] of after.entries()) {
      const old = before[index];
      expect(Buffer.from(row.ciphertext).equals(Buffer.from(old?.ciphertext ?? []))).toBe(true);
      expect(
        Buffer.from(row.encryptedDataKey).equals(Buffer.from(old?.encryptedDataKey ?? [])),
      ).toBe(false);
      expect(row.rewrappedAt).not.toBeNull();
    }

    for (const [index, id] of ids.entries()) {
      const revealed = await api.ok(
        api.call(w.owner, 'post', `${w.secrets(w.dev)}/${id}/reveal`),
        200,
        revealedSecretSchema,
      );
      expect(revealed.value).toBe(VALUES[index]);
    }
    expect(await verifyEnvelopes(ops(), { batchSize: 10 })).toEqual({ checked: 3, failed: [] });

    const again = await rewrap(ops(), { dryRun: false, batchSize: 2 });
    expect(again).toMatchObject({ pending: 0, rewrapped: 0 });

    const actions = (await h.db.auditEvent.findMany({ where: { actorType: 'SYSTEM' } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'encryption.key_rotated',
        'encryption.rewrap_started',
        'encryption.rewrap_completed',
      ]),
    );
    expect(lines.join('\n')).not.toMatch(/synthetic-rotation/);
  });

  it('resumes an interrupted rewrap without rewrapping anything twice', async () => {
    await seed();
    await keysRotate(ops(), (await readKeyringFile(keyringPath)).keyId);
    await reloadApi();
    const controller = new AbortController();
    const first = await rewrap(ops(), {
      dryRun: false,
      batchSize: 1,
      signal: controller.signal,
      onItem: (progress) => {
        if (progress.processed === 1) controller.abort();
      },
    });
    expect(first).toMatchObject({ rewrapped: 1, interrupted: true });
    expect(await versionsOn('1')).toBe(2);
    const interrupted = await h.db.auditEvent.count({
      where: { action: 'encryption.rewrap_interrupted' },
    });
    expect(interrupted).toBe(1);

    const second = await rewrap(ops(), { dryRun: false, batchSize: 1 });
    expect(second).toMatchObject({ pending: 2, rewrapped: 2, interrupted: false });
    expect(await versionsOn('2')).toBe(3);
  });

  it('never overwrites a wrapped key that changed after it was read', async () => {
    await seed();
    const row = await h.db.secretVersion.findFirstOrThrow();
    const stale = {
      kmsKeyVersion: '1',
      encryptedDataKey: Buffer.alloc(row.encryptedDataKey.length),
    };
    const { createRepositories } = await import('@envvault/database');
    const changed = await createRepositories(h.db).keyMaintenance.replaceWrappedKey(row.id, stale, {
      kmsKeyVersion: '2',
      encryptedDataKey: Buffer.alloc(row.encryptedDataKey.length, 1),
    });
    expect(changed).toBe(false);
    expect(
      (await h.db.secretVersion.findUniqueOrThrow({ where: { id: row.id } })).kmsKeyVersion,
    ).toBe('1');
  });

  it('reports tampered data keys by id and keeps the ciphertext immutable', async () => {
    await seed();
    const target = await h.db.secretVersion.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const tampered = Buffer.from(target.encryptedDataKey);
    tampered[5] = (tampered[5] ?? 0) ^ 0xff;
    await h.db.secretVersion.update({
      where: { id: target.id },
      data: { encryptedDataKey: new Uint8Array(tampered) },
    });
    await expect(
      h.db
        .$executeRaw`UPDATE "secret_versions" SET "ciphertext" = '\\x00' WHERE "id" = ${target.id}::uuid`,
    ).rejects.toThrow();

    const verify = await verifyEnvelopes(ops(), { batchSize: 10 });
    expect(verify).toEqual({ checked: 3, failed: [{ id: target.id, code: 'DECRYPTION_FAILED' }] });

    await keysRotate(ops(), (await readKeyringFile(keyringPath)).keyId);
    const report = await rewrap(ops(), { dryRun: false, batchSize: 10 });
    expect(report.rewrapped).toBe(2);
    expect(report.failed).toEqual([{ id: target.id, code: 'DECRYPTION_FAILED' }]);
    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'encryption.rewrap_completed' },
    });
    expect(event.outcome).toBe('FAILURE');
  });

  it('flags stored data that the configured keyring cannot decrypt', async () => {
    await seed();
    await writeKeyringFile(keyringPath, generateKeyring());
    expect(await keysStatus(ops())).toBe(3);
    expect(lines.join('\n')).toMatch(/3 secret versions \(not decryptable with this keyring\)/);
    expect(await verifyEnvelopes(ops(), { batchSize: 10 })).toEqual({ checked: 0, failed: [] });
  });
});

describe('retiring key versions', () => {
  it('refuses while referenced or without a backup that holds the version', async () => {
    await seed();
    const keyring = await readKeyringFile(keyringPath);
    await keysRotate(ops(), keyring.keyId);
    await reloadApi();
    const recovery = generateRecoveryKey();
    const recoveryPath = join(directory, `recovery-${recovery.id}.json`);
    await writeRecoveryKeyFile(recoveryPath, recovery);

    const onlyNew = join(directory, `backup-new-${recovery.id}.json`);
    const fresh = generateKeyring();
    await writeKeyringBackupFile(onlyNew, createKeyringBackup(fresh, recovery));
    const full = join(directory, `backup-full-${recovery.id}.json`);
    await writeKeyringBackupFile(
      full,
      createKeyringBackup(await readKeyringFile(keyringPath), recovery),
    );

    const retire = (backupPath: string, confirm?: string) =>
      keysRetire(ops(), { version: 1, confirm, backupPath, recoveryKeyPath: recoveryPath });
    await expect(retire(full, keyring.keyId)).rejects.toThrow('still use v1');

    await rewrap(ops(), { dryRun: false, batchSize: 10 });
    await expect(retire(onlyNew, keyring.keyId)).rejects.toThrow('does not hold v1');
    await expect(retire(full)).rejects.toThrow('--confirm');
    expect(await retire(full, keyring.keyId)).toBe(0);

    const after = await readKeyringFile(keyringPath);
    expect(after.versions.find((v) => v.version === 1)).toMatchObject({ status: 'retired' });
    expect(after.versions.find((v) => v.version === 1)?.key).toBeUndefined();
    expect(await h.db.auditEvent.count({ where: { action: 'encryption.key_retired' } })).toBe(1);

    lines.length = 0;
    expect(
      await keyringVerifyBackup(ops(), {
        backup: full,
        recoveryKeyFile: recoveryPath,
        againstDatabase: true,
      }),
    ).toBe(0);
    expect(lines.join('\n')).toContain('covered');
  });
});
