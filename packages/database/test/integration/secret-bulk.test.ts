import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getConstraintViolation } from '../../src/errors.js';
import {
  createRepositories,
  type NewSecretData,
  type NewSecretVersion,
} from '../../src/repositories/index.js';
import { createAuthorizedEnvironmentScope, type EnvironmentScope } from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import {
  createTenant,
  disconnectTestDb,
  expectTriggerRejection,
  expectViolation,
  fakeEnvelope,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();

function data(key: string, overrides: Partial<NewSecretData> = {}): NewSecretData {
  return {
    id: randomUUID(),
    key,
    description: null,
    type: 'SECRET',
    category: null,
    tags: [],
    isRequired: false,
    ...overrides,
  };
}

function version(t: Tenant, overrides: Partial<NewSecretVersion> = {}): NewSecretVersion {
  return {
    id: randomUUID(),
    encryptionKeyId: t.encryptionKeyId,
    kmsKeyVersion: '1',
    envelopeVersion: 1,
    origin: 'UPDATE',
    ...fakeEnvelope(),
    ...overrides,
  };
}

let t: Tenant;
let dev: EnvironmentScope;
let prod: EnvironmentScope;

beforeEach(async () => {
  await truncateAll(db);
  t = await createTenant(db, 'bulk');
  dev = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.developmentId);
  prod = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.productionId);
});

afterAll(disconnectTestDb);

async function seed(keys: string[], scope = dev, overrides: Partial<NewSecretData> = {}) {
  const rows = keys.map((key) => ({
    data: data(key, overrides),
    version: version(t, { origin: 'IMPORT' }),
  }));
  await withTransaction(db, (tx) =>
    createRepositories(tx).secretBulk.createWithVersions(scope, rows, t.userId),
  );
  return rows.map((r) => r.data.id);
}

describe('version history', () => {
  it('pages newest first and records provenance', async () => {
    const { id } = await withTransaction(db, (tx) =>
      createRepositories(tx).secrets.create(
        dev,
        data('HISTORY'),
        version(t, { origin: 'CREATE' }),
        t.userId,
      ),
    );
    let revision = 1;
    for (const reason of ['rotate', 'fix typo', null]) {
      const result = await withTransaction(db, (tx) =>
        createRepositories(tx).secrets.update(
          dev,
          id,
          revision,
          {},
          version(t, { changeReason: reason, kmsKeyVersion: '2' }),
          t.userId,
        ),
      );
      revision = result?.revision ?? 0;
    }
    const repos = createRepositories(db);
    const v1 = (
      await db.secretVersion.findFirstOrThrow({ where: { secretId: id, versionNumber: 1 } })
    ).id;
    await withTransaction(db, (tx) =>
      createRepositories(tx).secrets.update(
        dev,
        id,
        revision,
        {},
        version(t, { origin: 'ROLLBACK', restoredFromVersionId: v1, changeReason: 'back to v1' }),
        t.userId,
      ),
    );

    const first = await repos.secrets.listVersions(dev, id, { limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items.map((v) => [v.versionNumber, v.origin, v.isCurrent])).toEqual([
      [5, 'ROLLBACK', true],
      [4, 'UPDATE', false],
    ]);
    expect(first.items[0]).toMatchObject({ restoredFromVersion: 1, changeReason: 'back to v1' });
    expect(first.nextBefore).toBe(4);
    const second = await repos.secrets.listVersions(dev, id, { before: 4, limit: 2 });
    expect(second.items.map((v) => v.versionNumber)).toEqual([3, 2]);
    expect(second.items[1]).toMatchObject({ changeReason: 'rotate', keyVersion: 2 });
    const last = await repos.secrets.listVersions(dev, id, { before: 2, limit: 2 });
    expect(last).toMatchObject({
      items: [{ versionNumber: 1, origin: 'CREATE' }],
      nextBefore: null,
    });
    expect(JSON.stringify(first.items)).not.toMatch(/ciphertext|encryptedDataKey/);

    // A historical version is reachable only through its own secret and environment.
    await expect(repos.secrets.version(dev, id, v1)).resolves.toMatchObject({ versionNumber: 1 });
    await expect(repos.secrets.version(prod, id, v1)).resolves.toBeNull();
    await expect(repos.secrets.version(dev, randomUUID(), v1)).resolves.toBeNull();
  });

  it('keeps provenance immutable and rollbacks tied to their source', async () => {
    const { id } = await withTransaction(db, (tx) =>
      createRepositories(tx).secrets.create(
        dev,
        data('IMMUTABLE'),
        version(t, { origin: 'CREATE' }),
        t.userId,
      ),
    );
    const row = await db.secretVersion.findFirstOrThrow({ where: { secretId: id } });
    for (const change of [{ origin: 'ROLLBACK' as const }, { changeReason: 'rewritten' }]) {
      await expectTriggerRejection(
        db.secretVersion.update({ where: { id: row.id }, data: change }),
        /immutable/,
      );
    }
    await expectViolation(
      withTransaction(db, (tx) =>
        createRepositories(tx).secrets.update(
          dev,
          id,
          1,
          {},
          version(t, { origin: 'ROLLBACK' }),
          t.userId,
        ),
      ),
      'check',
      'secret_versions_rollback_source_chk',
    );
    // A rollback cannot point at a version of another secret.
    const [other] = await seed(['OTHER']);
    if (!other) throw new Error('seed failed');
    const foreign = await db.secretVersion.findFirstOrThrow({ where: { secretId: other } });
    await expectViolation(
      withTransaction(db, (tx) =>
        createRepositories(tx).secrets.update(
          dev,
          id,
          1,
          {},
          version(t, { origin: 'ROLLBACK', restoredFromVersionId: foreign.id }),
          t.userId,
        ),
      ),
      'foreign_key',
      'secret_versions_restored_from_fkey',
    );
  });
});

describe('SecretBulkRepository', () => {
  it('creates many variables with versions in two statements and rejects taken names', async () => {
    const ids = await seed(['A', 'B', 'C']);
    expect(await db.secretVersion.count({ where: { secretId: { in: ids } } })).toBe(3);
    const states = await createRepositories(db).secretBulk.liveByKeys(dev, ['A', 'C', 'Z']);
    expect(states.map((s) => s.key).sort()).toEqual(['A', 'C']);
    await expectViolation(seed(['D', 'A']), 'unique', 'secrets_environment_key_live_key');
    expect(await db.secret.count({ where: { key: 'D' } })).toBe(0);
  });

  it('overwrites values only where the revision still matches', async () => {
    const [a, b] = await seed(['A', 'B']);
    if (!a || !b) throw new Error('seed failed');
    await createRepositories(db).secrets.update(
      dev,
      b,
      1,
      { description: 'edited' },
      null,
      t.userId,
    );
    const updated = await withTransaction(db, (tx) =>
      createRepositories(tx).secretBulk.overwriteValues(
        dev,
        [
          { secretId: a, expectedRevision: 1, version: version(t, { origin: 'IMPORT' }) },
          { secretId: b, expectedRevision: 1, version: version(t, { origin: 'IMPORT' }) },
        ],
        t.userId,
      ),
    );
    expect(updated).toEqual([a]);
    const record = await createRepositories(db).secrets.get(dev, a);
    expect(record).toMatchObject({ currentVersionNumber: 2, revision: 2 });
  });

  it('deletes, restores and patches with revision checks inside the scope only', async () => {
    const [a, b, c] = await seed(['A', 'B', 'C'], dev, { tags: ['keep', 'old'] });
    const [foreign] = await seed(['A'], prod);
    if (!a || !b || !c || !foreign) throw new Error('seed failed');
    const bulk = createRepositories(db).secretBulk;

    const deleted = await bulk.softDelete(
      dev,
      [
        { id: a, expectedRevision: 1 },
        { id: b, expectedRevision: 9 },
        { id: foreign, expectedRevision: 1 },
      ],
      t.userId,
    );
    expect(deleted).toEqual([a]);
    expect((await createRepositories(db).secrets.get(prod, foreign))?.deletedAt).toBeNull();

    const patched = await bulk.patch(
      dev,
      [
        { id: b, expectedRevision: 1 },
        { id: c, expectedRevision: 1 },
      ],
      { category: 'Database', addTags: ['new', 'keep'], removeTags: ['old'], isRequired: true },
      t.userId,
    );
    expect(patched.sort()).toEqual([b, c].sort());
    expect(await createRepositories(db).secrets.get(dev, b)).toMatchObject({
      category: 'Database',
      tags: ['keep', 'new'],
      isRequired: true,
      revision: 2,
    });

    await expect(bulk.restore(dev, [{ id: a, expectedRevision: 2 }], t.userId)).resolves.toEqual([
      a,
    ]);
    await bulk.softDelete(dev, [{ id: a, expectedRevision: 3 }], t.userId);
    await seed(['A']);
    const error = await bulk
      .restore(dev, [{ id: a, expectedRevision: 4 }], t.userId)
      .catch((e: unknown) => e);
    expect(getConstraintViolation(error)?.constraint).toBe('secrets_environment_key_live_key');
  });

  it('refuses more than 20 tags', async () => {
    const [a] = await seed(['A']);
    if (!a) throw new Error('seed failed');
    await expectViolation(
      createRepositories(db).secretBulk.patch(
        dev,
        [{ id: a, expectedRevision: 1 }],
        { addTags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) },
        t.userId,
      ),
      'check',
      'secrets_tags_count_chk',
    );
  });

  it('selects every matching variable across pages, capped', async () => {
    await seed(Array.from({ length: 30 }, (_, i) => `KEY_${String(i).padStart(2, '0')}`));
    await seed(['OTHER_ENV'], prod);
    const bulk = createRepositories(db).secretBulk;
    const all = await bulk.selection(dev, { status: 'active' }, 25);
    expect(all.total).toBe(30);
    expect(all.items).toHaveLength(25);
    const filtered = await bulk.selection(dev, { status: 'active', q: 'key_1' }, 25);
    expect(filtered.items.map((i) => i.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `KEY_1${String(i)}`),
    );
    const exported = await bulk.forExport(dev, undefined, 100);
    expect(exported).toHaveLength(30);
    expect(exported.every((row) => row.stored !== null)).toBe(true);
  });
});
