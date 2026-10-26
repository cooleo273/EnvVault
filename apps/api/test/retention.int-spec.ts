import { generateKeyring, IntegrityKeys, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  maintenanceJobSchema,
  retentionPolicySchema,
  retentionPreviewSchema,
  workspaceDetailSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sealPending, verifyChains } from '../src/audit/audit-chain.js';
import { processNextJob } from '../src/retention/maintenance-worker.service.js';
import { errorCode, Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

let h: Harness;
let api: ReturnType<typeof client>;
const DAY = 86_400_000;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  api = client(h);
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

type World = Awaited<ReturnType<ReturnType<typeof client>['world']>>;

/** Rewrites timestamps the way time passing would; the triggers forbid it otherwise. */
async function asDatabaseOwner(tables: string[], statement: () => Promise<unknown>) {
  for (const t of tables) await h.db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
  try {
    await statement();
  } finally {
    for (const t of tables) await h.db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
  }
}

async function secret(w: World, env: string, key: string, values: string[]) {
  const path = w.secrets(env);
  const created = await api.createSecret(w.owner, path, { key, value: values[0] });
  let revision = 1;
  for (const value of values.slice(1)) {
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${created.id}`, { expectedRevision: revision, value }),
      200,
    );
    revision += 1;
  }
  return { id: created.id, path, revision };
}

async function remove(w: World, env: string, id: string, ageDays = 0) {
  await api.ok(api.call(w.owner, 'delete', `${w.secrets(env)}/${id}`), 204);
  if (ageDays > 0) {
    await h.db.secret.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - ageDays * DAY) },
    });
  }
}

const policy = (overrides: object = {}) => ({
  deletedSecretDays: null,
  versionKeepCount: null,
  versionMinAgeDays: null,
  snapshotDays: null,
  auditDays: null,
  includeProtected: false,
  ...overrides,
});

async function slugOf(w: World) {
  return (await api.ok(api.call(w.owner, 'get', `/workspaces/${w.ws}`), 200, workspaceDetailSchema))
    .slug;
}

async function run(w: World) {
  await api.stepUp(w.owner);
  const job = await api.ok(
    api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/runs`, { confirm: await slugOf(w) }),
    202,
    maintenanceJobSchema,
  );
  expect(job.status).toBe('queued');
  expect(await processNextJob(h.db)).toBe(true);
  return api.ok(
    api.call(w.owner, 'get', `/workspaces/${w.ws}/retention/runs/${job.id}`),
    200,
    maintenanceJobSchema,
  );
}

describe('retention policies', () => {
  it('needs workspace:update to read and change, and workspace:delete with a step up to purge', async () => {
    const w = await api.world('ret-auth');
    const member = h.newUser('ret-member');
    await api.join(w.owner, w.ws, member);
    expect(errorCode((await api.call(member, 'get', `/workspaces/${w.ws}/retention`)).body)).toBe(
      'FORBIDDEN',
    );

    const saved = await api.ok(
      api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, policy({ deletedSecretDays: 30 })),
      200,
      retentionPolicySchema,
    );
    expect(saved.deletedSecretDays).toBe(30);
    expect(
      (await api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, policy({ auditDays: 30 })))
        .status,
    ).toBe(400);
    expect(
      errorCode(
        (
          await api.call(
            w.owner,
            'put',
            `/workspaces/${w.ws}/retention`,
            policy({ includeProtected: true }),
          )
        ).body,
      ),
    ).toBe('STEP_UP_REQUIRED');
    expect(
      (await api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, { ...policy(), extra: 1 }))
        .status,
    ).toBe(400);

    const start = () =>
      api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/runs`, { confirm: 'wrong' });
    expect(errorCode((await start()).body)).toBe('STEP_UP_REQUIRED');
    await api.stepUp(w.owner);
    expect(errorCode((await start()).body)).toBe('CONFIRMATION_MISMATCH');
    const confirm = { confirm: await slugOf(w) };
    await api.ok(api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/runs`, confirm), 202);
    expect(
      errorCode(
        (await api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/runs`, confirm)).body,
      ),
    ).toBe('RETENTION_RUN_ACTIVE');

    const events = await h.db.auditEvent.findMany({
      where: { action: { startsWith: 'retention.' } },
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['retention.policy_updated', 'retention.purge_requested']),
    );
  });
});

describe('retention runs', () => {
  it('purges only what nothing still needs, previewing the same counts first', async () => {
    const w = await api.world('ret-run');
    const history = await secret(w, w.dev, 'HISTORY', ['h1', 'h2', 'h3', 'h4']);
    const rolled = await secret(w, w.dev, 'ROLLED', ['r1', 'r2']);
    const versions = await h.db.secretVersion.findMany({
      where: { secretId: rolled.id },
      orderBy: { versionNumber: 'asc' },
    });
    await api.ok(
      api.call(w.owner, 'post', `${rolled.path}/${rolled.id}/rollback`, {
        versionId: versions[0]?.id,
        expectedRevision: rolled.revision,
      }),
      200,
    );
    const snapped = await secret(w, w.dev, 'SNAPPED', ['s1']);
    const deletedSnapped = await secret(w, w.dev, 'DELETED_SNAPPED', ['d1']);
    await api.ok(
      api.call(
        w.owner,
        'post',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}/snapshots`,
        {},
      ),
      201,
    );
    await api.ok(
      api.call(w.owner, 'patch', `${snapped.path}/${snapped.id}`, {
        expectedRevision: 1,
        value: 's2',
      }),
      200,
    );
    await api.ok(
      api.call(w.owner, 'patch', `${snapped.path}/${snapped.id}`, {
        expectedRevision: 2,
        value: 's3',
      }),
      200,
    );
    await remove(w, w.dev, deletedSnapped.id, 10);
    const deletedOld = await secret(w, w.dev, 'DELETED_OLD', ['o1']);
    await remove(w, w.dev, deletedOld.id, 10);
    const deletedRecent = await secret(w, w.dev, 'DELETED_RECENT', ['n1']);
    await remove(w, w.dev, deletedRecent.id);
    // A deleted variable in the protected environment (written directly: the owner holds no grant there).
    const ownerId = (await h.db.user.findFirstOrThrow({ where: { email: w.owner.email } })).id;
    await h.db.secret.create({
      data: {
        createdByUserId: ownerId,
        updatedByUserId: ownerId,
        workspaceId: w.ws,
        projectId: w.project,
        environmentId: w.prod,
        key: 'PROD_DELETED',
        type: 'STRING',
        deletedAt: new Date(Date.now() - 10 * DAY),
      },
    });

    await api.ok(
      api.call(
        w.owner,
        'put',
        `/workspaces/${w.ws}/retention`,
        policy({ deletedSecretDays: 7, versionKeepCount: 1, versionMinAgeDays: 0 }),
      ),
      200,
    );
    const preview = await api.ok(
      api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/preview`),
      200,
      retentionPreviewSchema,
    );
    expect(preview.counts).toEqual({
      deletedSecrets: 1,
      versions: 5,
      snapshots: 0,
      auditEvents: 0,
    });

    const done = await run(w);
    expect(done).toMatchObject({ status: 'succeeded', counts: preview.counts, errorCode: null });

    const left = await h.db.secret.findMany({ select: { key: true } });
    expect(left.map((s) => s.key).sort()).toEqual(
      ['DELETED_RECENT', 'DELETED_SNAPPED', 'HISTORY', 'PROD_DELETED', 'ROLLED', 'SNAPPED'].sort(),
    );
    const numbers = async (id: string) =>
      (
        await h.db.secretVersion.findMany({
          where: { secretId: id },
          orderBy: { versionNumber: 'asc' },
        })
      ).map((v) => v.versionNumber);
    expect(await numbers(history.id)).toEqual([4]);
    // v1 stays: the rollback (v3) was restored from it.
    expect(await numbers(rolled.id)).toEqual([1, 3]);
    // v1 stays: the snapshot still references it.
    expect(await numbers(snapped.id)).toEqual([1, 3]);
    const revealed = await api.call(w.owner, 'post', `${history.path}/${history.id}/reveal`);
    expect(revealed.status).toBe(200);
    expect(
      await h.db.auditEvent.count({
        where: { action: 'retention.purge_completed', outcome: 'SUCCESS' },
      }),
    ).toBe(1);

    // Once the snapshot expires, what it kept alive goes in the same run.
    await asDatabaseOwner(
      ['environment_snapshots'],
      () =>
        h.db
          .$executeRaw`UPDATE "environment_snapshots" SET "created_at" = now() - interval '3 days'`,
    );
    await api.ok(
      api.call(
        w.owner,
        'put',
        `/workspaces/${w.ws}/retention`,
        policy({
          deletedSecretDays: 7,
          versionKeepCount: 1,
          versionMinAgeDays: 0,
          snapshotDays: 1,
        }),
      ),
      200,
    );
    const second = await run(w);
    expect(second.counts).toEqual({ deletedSecrets: 1, versions: 1, snapshots: 1, auditEvents: 0 });
    expect(await h.db.secret.count({ where: { key: 'PROD_DELETED' } })).toBe(1);
  });

  it('purges old audit events as a prefix of the sealed chain and keeps it verifiable', async () => {
    const w = await api.world('ret-audit');
    await secret(w, w.dev, 'A', ['a1']);
    await secret(w, w.dev, 'B', ['b1', 'b2']);
    const events = await h.db.auditEvent.findMany({
      where: { workspaceId: w.ws },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    const old = events.slice(0, 3).map((e) => e.id);
    await asDatabaseOwner(['audit_events'], async () => {
      for (const [index, id] of old.entries()) {
        await h.db
          .$executeRaw`UPDATE "audit_events" SET "occurred_at" = now() - ${`${String(200 - index)} days`}::interval WHERE "id" = ${id}::uuid`;
      }
    });
    const keys = IntegrityKeys.ephemeral();
    const later = new Date(Date.now() + 60 * 60_000);
    await sealPending(h.db, keys, { now: later });

    await api.ok(
      api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, policy({ auditDays: 90 })),
      200,
    );
    const done = await run(w);
    expect(done.counts.auditEvents).toBe(3);
    expect(await h.db.auditEvent.count({ where: { id: { in: old } } })).toBe(0);
    const checkpoint = await h.db.auditSealCheckpoint.findFirstOrThrow({
      where: { chainId: w.ws },
    });
    expect(checkpoint).toMatchObject({ seq: 3n, reason: 'retention_purge' });

    await sealPending(h.db, keys, { now: later });
    const chain = (await verifyChains(h.db, keys)).chains.find((c) => c.chainId === w.ws);
    expect(chain).toMatchObject({ firstSeq: '4', problems: [] });
    expect(await h.db.$executeRawUnsafe('SELECT 1')).toBeDefined();
    await expect(
      h.db.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "workspace_id" = '${w.ws}'`),
    ).rejects.toThrow();
  });

  it('records a failed run instead of dropping it', async () => {
    const w = await api.world('ret-fail');
    await api.ok(
      api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, policy({ snapshotDays: 1 })),
      200,
    );
    await api.stepUp(w.owner);
    const job = await api.ok(
      api.call(w.owner, 'post', `/workspaces/${w.ws}/retention/runs`, { confirm: await slugOf(w) }),
      202,
      z.object({ id: z.uuid() }),
    );
    await h.db.maintenanceJob.update({
      where: { id: job.id },
      data: { parameters: { broken: true } },
    });
    expect(await processNextJob(h.db)).toBe(true);
    const stored = await h.db.maintenanceJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: 'failed', errorCode: 'PURGE_FAILED' });
    expect(await h.db.auditEvent.count({ where: { action: 'retention.purge_failed' } })).toBe(1);
  });
});
