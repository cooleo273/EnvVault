import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateIntegrityKeyFile,
  generateKeyring,
  IntegrityKeys,
  LocalKeyProvider,
  writeIntegrityKeyFile,
} from '@envvault/crypto';
import { createRepositories } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sealPending, verifyChains } from '../src/audit/audit-chain.js';
import type { Env } from '../src/config/env.js';
import { auditVerify } from '../src/ops/audit-ops.js';
import { OpsContext } from '../src/ops/context.js';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

let h: Harness;
let api: ReturnType<typeof client>;
let keys: IntegrityKeys;
let directory: string;
let keyPath: string;
const lines: string[] = [];
const later = () => new Date(Date.now() + 60 * 60_000);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'envvault-audit-'));
  keyPath = join(directory, 'integrity.json');
  const file = generateIntegrityKeyFile();
  await writeIntegrityKeyFile(keyPath, file);
  keys = new IntegrityKeys(file);
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  api = client(h);
});
afterAll(async () => {
  await h.stop();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAllTables(h.db);
  lines.length = 0;
});

function ops(): OpsContext {
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    INTEGRITY_KEY_FILE: keyPath,
  } as unknown as Env;
  return new OpsContext(
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    () => env,
    h.db,
  );
}

/** Acts as someone with owner rights on the database, bypassing the append only triggers. */
async function asDatabaseOwner(statement: () => Promise<unknown>): Promise<void> {
  await h.db.$executeRawUnsafe('ALTER TABLE "audit_events" DISABLE TRIGGER USER');
  await h.db.$executeRawUnsafe('ALTER TABLE "audit_seals" DISABLE TRIGGER USER');
  try {
    await statement();
  } finally {
    await h.db.$executeRawUnsafe('ALTER TABLE "audit_events" ENABLE TRIGGER USER');
    await h.db.$executeRawUnsafe('ALTER TABLE "audit_seals" ENABLE TRIGGER USER');
  }
}

async function activity() {
  const a = await api.world('seal-a');
  await api.createSecret(a.owner, a.secrets(a.dev), { key: 'A_ONE', value: 'synthetic-seal-a1' });
  await api.createSecret(a.owner, a.secrets(a.dev), { key: 'A_TWO', value: 'synthetic-seal-a2' });
  const b = await api.world('seal-b');
  await api.createSecret(b.owner, b.secrets(b.dev), { key: 'B_ONE', value: 'synthetic-seal-b1' });
  await createRepositories(h.db).audit.appendSystem({
    action: 'encryption.key_rotated',
    outcome: 'SUCCESS',
    resourceType: 'encryption_key',
    metadata: { keyId: 'local-test' },
  });
  return { a, b };
}

describe('audit seals', () => {
  it('seals every event once, per workspace chain, and verifies them', async () => {
    const { a, b } = await activity();
    const events = await h.db.auditEvent.count();
    expect((await sealPending(h.db, keys, { now: later() })).sealed).toBe(events);
    expect((await sealPending(h.db, keys, { now: later() })).sealed).toBe(0);

    const report = await verifyChains(h.db, keys, { now: later() });
    const chains = report.chains.map((c) => c.chainId).sort();
    expect(chains).toEqual([a.ws, b.ws, 'platform'].sort());
    for (const chain of report.chains) {
      expect(chain.problems).toEqual([]);
      expect(chain.firstSeq).toBe('1');
    }
    expect(report.unsealed).toBe(0);
    const sealed = await h.db.auditSeal.findMany();
    expect(sealed.every((s) => s.mac.length === 32)).toBe(true);
  });

  it('leaves events within the grace period for the next pass', async () => {
    await activity();
    expect((await sealPending(h.db, keys)).sealed).toBe(0);
  });

  it('detects an edited event and names only that seal', async () => {
    const { a } = await activity();
    await sealPending(h.db, keys, { now: later() });
    const target = await h.db.auditSeal.findFirstOrThrow({
      where: { chainId: a.ws, seq: 2n },
    });
    await asDatabaseOwner(
      () =>
        h.db
          .$executeRaw`UPDATE "audit_events" SET "metadata" = '{"key":"FORGED"}'::jsonb WHERE "id" = ${target.eventId}::uuid`,
    );
    const chain = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === a.ws);
    expect(chain?.problems).toEqual([{ kind: 'mac_mismatch', seq: '2', eventId: target.eventId }]);
    expect(await auditVerify(ops(), { expectHeads: [] })).toBe(1);
    expect(lines.join('\n')).toContain('Verification FAILED');
  });

  it('detects a removed event in the middle of a chain', async () => {
    const { a } = await activity();
    await sealPending(h.db, keys, { now: later() });
    const target = await h.db.auditSeal.findFirstOrThrow({ where: { chainId: a.ws, seq: 2n } });
    await asDatabaseOwner(async () => {
      await h.db.$executeRaw`DELETE FROM "audit_seals" WHERE "event_id" = ${target.eventId}::uuid`;
      await h.db.$executeRaw`DELETE FROM "audit_events" WHERE "id" = ${target.eventId}::uuid`;
    });
    const chain = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === a.ws);
    expect(chain?.problems).toContainEqual({ kind: 'gap', expected: '2', found: '3' });
  });

  it('detects a removed tail only against a head recorded elsewhere', async () => {
    const { a } = await activity();
    await sealPending(h.db, keys, { now: later() });
    const before = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === a.ws);
    const head = `${a.ws}:${before?.head?.seq ?? ''}:${before?.head?.mac.slice(0, 32) ?? ''}`;
    const last = await h.db.auditSeal.findFirstOrThrow({
      where: { chainId: a.ws },
      orderBy: { seq: 'desc' },
    });
    await asDatabaseOwner(async () => {
      await h.db.$executeRaw`DELETE FROM "audit_seals" WHERE "event_id" = ${last.eventId}::uuid`;
      await h.db.$executeRaw`DELETE FROM "audit_events" WHERE "id" = ${last.eventId}::uuid`;
    });
    const after = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === a.ws);
    expect(after?.problems).toEqual([]);
    expect(await auditVerify(ops(), { expectHeads: [head] })).toBe(1);
    expect(lines.join('\n')).toContain('head is behind');
  });

  it('rejects seals made without the key', async () => {
    const { a } = await activity();
    await sealPending(h.db, keys, { now: later() });
    const other = IntegrityKeys.ephemeral();
    const report = await verifyChains(h.db, other);
    expect(report.chains.find((c) => c.chainId === a.ws)?.problems[0]?.kind).toBe('unknown_key');

    const forged = await h.db.auditSeal.findFirstOrThrow({ where: { chainId: a.ws, seq: 1n } });
    await asDatabaseOwner(
      () =>
        h.db
          .$executeRaw`UPDATE "audit_seals" SET "mac" = ${Buffer.alloc(32, 7)} WHERE "event_id" = ${forged.eventId}::uuid`,
    );
    const chain = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === a.ws);
    // The next seal chains on the forged MAC, so it fails as well.
    expect(chain?.problems.map((p) => p.kind === 'mac_mismatch' && p.seq)).toEqual(['1', '2']);
  });

  it('keeps the append only rules for seals and events', async () => {
    await activity();
    await sealPending(h.db, keys, { now: later() });
    await expect(h.db.$executeRawUnsafe('DELETE FROM "audit_seals"')).rejects.toThrow();
    await expect(
      h.db.$executeRawUnsafe('UPDATE "audit_events" SET "action" = \'x.y\''),
    ).rejects.toThrow();
    await expect(h.db.$executeRawUnsafe('TRUNCATE "audit_events" CASCADE')).rejects.toThrow();
  });
});
