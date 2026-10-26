import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateIntegrityKeyFile,
  generateKeyring,
  generateRecoveryKey,
  IntegrityKeys,
  LocalKeyProvider,
  readKeyringFile,
  writeIntegrityKeyFile,
  writeKeyringFile,
  writeRecoveryKeyFile,
} from '@envvault/crypto';
import { createPrismaClient, type PrismaClient } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import { revealedSecretSchema } from '@envvault/shared';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sealPending, verifyChains } from '../../src/audit/audit-chain.js';
import type { Env } from '../../src/config/env.js';
import { OpsContext } from '../../src/ops/context.js';
import { keyringBackup, keyringRestore, keyringVerifyBackup } from '../../src/ops/keyring-ops.js';
import { verifyEnvelopes } from '../../src/ops/keys.js';
import { Harness } from '../support/harness.js';
import { client } from '../support/secrets-world.js';

/*
 * Disaster recovery drill with synthetic data on disposable databases:
 * back up the keyring (encrypted under a recovery key) and the database
 * (pg_dump), lose both, restore them into a separate database and key path,
 * and verify that every value decrypts, the audit chain verifies and the
 * history is consistent. Timings go to DRILL_OUT as JSON.
 */
const SOURCE = process.env.TEST_DATABASE_URL ?? '';
const TARGET = SOURCE.replace(/\/([^/?]+)(\?|$)/, '/envvault_dr_restore_test$2');
const VALUES = Array.from({ length: 50 }, (_, i) => `synthetic-dr-value-${String(i)}`);

let h: Harness;
let api: ReturnType<typeof client>;
let directory: string;
const timings: Record<string, number> = {};
const lines: string[] = [];

function plain(url: string): string {
  const u = new URL(url);
  u.search = '';
  return u.toString();
}

async function timed<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
}

function ops(databaseUrl: string, keyringPath: string, integrityPath: string, db?: PrismaClient) {
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_CONNECT_TIMEOUT_MS: 10_000,
    ENCRYPTION_PROVIDER: 'local',
    ENCRYPTION_KEYRING_FILE: keyringPath,
    ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED: false,
    INTEGRITY_KEY_FILE: integrityPath,
  } as unknown as Env;
  return new OpsContext({ out: (l) => lines.push(l), err: (l) => lines.push(l) }, () => env, db);
}

beforeAll(async () => {
  if (!new URL(TARGET).pathname.includes('test'))
    throw new Error('Restore target must be a test database');
  directory = await mkdtemp(join(tmpdir(), 'envvault-dr-'));
});
afterAll(async () => {
  await h.stop();
  await rm(directory, { recursive: true, force: true });
  if (process.env.DRILL_OUT)
    await writeFile(process.env.DRILL_OUT, `${JSON.stringify(timings, null, 2)}\n`);
});

it('restores the database and the keyring into an isolated environment', async () => {
  const keyringPath = join(directory, 'keyring.json');
  const integrityPath = join(directory, 'integrity.json');
  await writeKeyringFile(keyringPath, generateKeyring());
  await writeIntegrityKeyFile(integrityPath, generateIntegrityKeyFile());
  const provider = new LocalKeyProvider(await readKeyringFile(keyringPath), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  api = client(h);
  await truncateAllTables(h.db);

  // Synthetic workload: values with history, a snapshot and audit events.
  const w = await api.world('drill');
  const ids: string[] = [];
  for (const [i, value] of VALUES.entries()) {
    const created = await api.createSecret(w.owner, w.secrets(w.dev), {
      key: `DR_${String(i)}`,
      value,
    });
    ids.push(created.id);
  }
  await api.ok(
    api.call(w.owner, 'patch', `${w.secrets(w.dev)}/${ids[0] ?? ''}`, {
      expectedRevision: 1,
      value: 'synthetic-dr-updated',
    }),
    200,
  );
  await api.ok(
    api.call(
      w.owner,
      'post',
      `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}/snapshots`,
      {},
    ),
    201,
  );
  const integrity = new IntegrityKeys(
    (await import('@envvault/crypto')).parseIntegrityKeyFile(
      JSON.parse((await import('node:fs')).readFileSync(integrityPath, 'utf8')),
    ),
  );
  await sealPending(h.db, integrity, { now: new Date(Date.now() + 3_600_000) });
  const expectedHead = (await verifyChains(h.db, integrity)).chains.find(
    (c) => c.chainId === w.ws,
  )?.head;

  // Backups: keyring under a recovery key kept elsewhere, database with pg_dump.
  const recovery = generateRecoveryKey();
  const recoveryPath = join(directory, 'offline', 'recovery-key.json');
  await writeRecoveryKeyFile(recoveryPath, recovery);
  const backupPath = join(directory, 'backups', 'keyring-backup.json');
  const source = ops(SOURCE, keyringPath, integrityPath, h.db);
  await timed('keyring backup', () =>
    keyringBackup(source, {
      recoveryKeyFile: recoveryPath,
      out: backupPath,
      keyringFile: keyringPath,
      record: true,
    }),
  );
  const dumpPath = join(directory, 'backups', 'database.dump');
  await timed('pg_dump', () =>
    execFileSync('pg_dump', ['--format=custom', `--file=${dumpPath}`, plain(SOURCE)]),
  );

  // Disaster: the keyring is gone. Restore into an isolated database and key path.
  await rm(keyringPath);
  const admin = plain(SOURCE.replace(/\/([^/?]+)(\?|$)/, '/postgres$2'));
  execFileSync('psql', [admin, '-qc', 'DROP DATABASE IF EXISTS envvault_dr_restore_test']);
  execFileSync('psql', [admin, '-qc', 'CREATE DATABASE envvault_dr_restore_test']);
  await timed('pg_restore', () =>
    execFileSync('pg_restore', ['--no-owner', `--dbname=${plain(TARGET)}`, dumpPath]),
  );
  const restoredKeyring = join(directory, 'isolated', 'keyring.json');
  const restoreOps = ops(TARGET, restoredKeyring, integrityPath);
  expect(
    await timed('keyring restore', () =>
      keyringRestore(restoreOps, {
        backup: backupPath,
        recoveryKeyFile: recoveryPath,
        to: restoredKeyring,
        overwrite: undefined,
      }),
    ),
  ).toBe(0);

  // Verification against the restored copy.
  const restored = createPrismaClient({ connectionString: TARGET });
  try {
    const checkOps = ops(TARGET, restoredKeyring, integrityPath, restored);
    expect(
      await keyringVerifyBackup(checkOps, {
        backup: backupPath,
        recoveryKeyFile: recoveryPath,
        againstDatabase: true,
      }),
    ).toBe(0);
    const verify = await timed('verify every envelope', () =>
      verifyEnvelopes(checkOps, { batchSize: 200 }),
    );
    expect(verify).toEqual({ checked: VALUES.length + 1, failed: [] });

    const chain = await timed('verify audit chain', async () =>
      (await verifyChains(restored, integrity)).chains.find((c) => c.chainId === w.ws),
    );
    expect(chain?.problems).toEqual([]);
    expect(chain?.head).toEqual(expectedHead);

    const migrations = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: new URL('../../../../packages/database/', import.meta.url),
      env: { ...process.env, DATABASE_URL: TARGET, DIRECT_URL: TARGET },
      encoding: 'utf8',
      // pnpm is a shell script on some systems.
      shell: true,
    });
    expect(migrations).toContain('Database schema is up to date');

    const consistency = await restored.$queryRaw<{ problem: string; n: bigint }[]>`
      SELECT 'current version of another variable' AS problem, count(*) AS n FROM secrets s
        JOIN secret_versions v ON v.id = s.current_version_id WHERE v.secret_id <> s.id
      UNION ALL
      SELECT 'latest number behind history', count(*) FROM secrets s
        WHERE s.latest_version_number < (SELECT coalesce(max(version_number), 0) FROM secret_versions v WHERE v.secret_id = s.id)
      UNION ALL
      SELECT 'snapshot entry without its version', count(*) FROM environment_snapshot_entries e
        LEFT JOIN secret_versions v ON v.id = e.secret_version_id WHERE e.secret_version_id IS NOT NULL AND v.id IS NULL`;
    for (const row of consistency) expect(Number(row.n), row.problem).toBe(0);
  } finally {
    await restored.$disconnect();
  }

  // The restored keyring decrypts through the application exactly as before.
  const restoredProvider = new LocalKeyProvider(await readKeyringFile(restoredKeyring), {
    nodeEnv: 'test',
  });
  expect((await restoredProvider.validateKeyConfiguration()).active.keyVersion).toBe(1);
  const revealed = await api.ok(
    api.call(w.owner, 'post', `${w.secrets(w.dev)}/${ids[1] ?? ''}/reveal`),
    200,
    revealedSecretSchema,
  );
  expect(revealed.value).toBe(VALUES[1]);
  expect(lines.join('\n')).not.toMatch(/synthetic-dr/);
});
