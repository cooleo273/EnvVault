import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getConstraintViolation } from '../../src/errors.js';
import { createRepositories } from '../../src/repositories/index.js';
import type { NewSecretData, NewSecretVersion } from '../../src/repositories/index.js';
import {
  createAuthorizedEnvironmentScope,
  createAuthorizedWorkspaceScope,
  type EnvironmentScope,
} from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import {
  createTenant,
  disconnectTestDb,
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

function version(tenant: Tenant): NewSecretVersion {
  return {
    id: randomUUID(),
    encryptionKeyId: tenant.encryptionKeyId,
    kmsKeyVersion: '1',
    envelopeVersion: 1,
    origin: 'UPDATE',
    ...fakeEnvelope(),
  };
}

describe('SecretRepository', () => {
  let t: Tenant;
  let dev: EnvironmentScope;
  let prod: EnvironmentScope;

  beforeEach(async () => {
    await truncateAll(db);
    t = await createTenant(db, 'sr');
    dev = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.developmentId);
    prod = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.productionId);
  });

  afterAll(disconnectTestDb);

  async function create(key: string, scope = dev, overrides: Partial<NewSecretData> = {}) {
    return withTransaction(db, (tx) =>
      createRepositories(tx).secrets.create(scope, data(key, overrides), version(t), t.userId),
    );
  }

  it('creates metadata and the first version atomically', async () => {
    const { id, revision } = await create('DATABASE_URL');
    expect(revision).toBe(1);
    const record = await createRepositories(db).secrets.get(dev, id);
    expect(record).toMatchObject({ key: 'DATABASE_URL', currentVersionNumber: 1, revision: 1 });
    expect(Object.keys(record ?? {})).not.toEqual(
      expect.arrayContaining(['ciphertext', 'encryptedDataKey', 'iv', 'authTag']),
    );
    await expect(db.secretVersion.count({ where: { secretId: id } })).resolves.toBe(1);
  });

  it('creates a variable without a value', async () => {
    const { id } = await withTransaction(db, (tx) =>
      createRepositories(tx).secrets.create(dev, data('PLACEHOLDER'), null, t.userId),
    );
    const repos = createRepositories(db);
    expect((await repos.secrets.get(dev, id))?.currentVersionNumber).toBeNull();
    await expect(repos.secrets.currentVersion(dev, id)).resolves.toBeNull();
  });

  it('rejects duplicate names per environment but allows them across environments', async () => {
    await create('TOKEN');
    await expectViolation(create('TOKEN'), 'unique', 'secrets_environment_key_live_key');
    await expect(create('TOKEN', prod)).resolves.toBeDefined();
    // Case is significant, as in POSIX environments.
    await expect(create('token')).resolves.toBeDefined();
    await expect(createRepositories(db).secrets.isKeyTaken(dev, 'TOKEN')).resolves.toBe(true);
  });

  it('rolls everything back when the version insert fails', async () => {
    const bad = { ...version(t), iv: new Uint8Array(3) };
    await expectViolation(
      withTransaction(db, (tx) =>
        createRepositories(tx).secrets.create(dev, data('BROKEN'), bad, t.userId),
      ),
      'check',
      'secret_versions_iv_len_chk',
    );
    await expect(db.secret.count()).resolves.toBe(0);
  });

  it('refuses updates from a stale revision (optimistic concurrency)', async () => {
    const { id } = await create('API_KEY');
    const repos = createRepositories(db);
    await expect(
      repos.secrets.update(dev, id, 1, { description: 'first' }, null, t.userId),
    ).resolves.toEqual({ revision: 2, versionNumber: null });
    await expect(
      repos.secrets.update(dev, id, 1, { description: 'stale' }, null, t.userId),
    ).resolves.toBeNull();
    expect((await repos.secrets.get(dev, id))?.description).toBe('first');
  });

  it('allocates version numbers safely under concurrent writers', async () => {
    const { id } = await create('ROTATING');
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        withTransaction(db, (tx) =>
          createRepositories(tx).secrets.update(dev, id, 1, {}, version(t), t.userId),
        ),
      ),
    );
    const winners = attempts.filter((a) => a.status === 'fulfilled' && a.value !== null);
    expect(winners).toHaveLength(1);
    const record = await createRepositories(db).secrets.get(dev, id);
    expect(record).toMatchObject({ revision: 2, currentVersionNumber: 2 });
    await expect(db.secretVersion.count({ where: { secretId: id } })).resolves.toBe(2);
  });

  it('appends sequential versions and keeps history immutable', async () => {
    const { id } = await create('SEQ');
    let revision = 1;
    for (let i = 0; i < 3; i++) {
      const result = await withTransaction(db, (tx) =>
        createRepositories(tx).secrets.update(dev, id, revision, {}, version(t), t.userId),
      );
      revision = result?.revision ?? 0;
    }
    const { items: versions } = await createRepositories(db).secrets.listVersions(dev, id);
    expect(versions.map((v) => v.versionNumber)).toEqual([4, 3, 2, 1]);
    expect(versions.filter((v) => v.isCurrent).map((v) => v.versionNumber)).toEqual([4]);
    expect(Object.keys(versions[0] ?? {})).not.toContain('ciphertext');
  });

  it('soft deletes, hides from the live list and restores', async () => {
    const { id } = await create('OLD');
    const repos = createRepositories(db);
    await expect(repos.secrets.softDelete(dev, id, t.userId, 99)).resolves.toBe(false);
    await expect(repos.secrets.softDelete(dev, id, t.userId, 1)).resolves.toBe(true);
    const query = { sort: 'name', order: 'asc', skip: 0, take: 50 } as const;
    expect((await repos.secrets.list(dev, { ...query, status: 'active' })).total).toBe(0);
    const deleted = await repos.secrets.list(dev, { ...query, status: 'deleted' });
    expect(deleted.items[0]).toMatchObject({ id, deletedBy: { email: expect.any(String) } });
    // History survives the deletion.
    await expect(db.secretVersion.count({ where: { secretId: id } })).resolves.toBe(1);
    await expect(repos.secrets.restore(dev, id, t.userId)).resolves.toBe(true);
    expect(await repos.secrets.get(dev, id)).toMatchObject({ deletedAt: null, deletedBy: null });
    await expect(repos.secrets.restore(dev, id, t.userId)).resolves.toBe(false);
  });

  it('refuses to restore over a live variable with the same name', async () => {
    const { id } = await create('REUSED');
    const repos = createRepositories(db);
    await repos.secrets.softDelete(dev, id, t.userId);
    await create('REUSED');
    const error = await repos.secrets.restore(dev, id, t.userId).catch((e: unknown) => e);
    expect(getConstraintViolation(error)?.constraint).toBe('secrets_environment_key_live_key');
  });

  it('filters, searches, sorts and paginates', async () => {
    await create('DB_HOST', dev, { type: 'STRING', category: 'Database', tags: ['infra'] });
    await create('DB_PASSWORD', dev, { category: 'Database', description: 'primary credential' });
    await create('FEATURE_FLAG', dev, { type: 'BOOLEAN' });
    await create('STRIPE_KEY', dev, { category: 'Payments', tags: ['infra', 'billing'] });
    const repos = createRepositories(db);
    const base = { status: 'active', sort: 'name', order: 'asc', skip: 0, take: 50 } as const;
    const keys = async (query: Partial<Parameters<typeof repos.secrets.list>[1]>) =>
      (await repos.secrets.list(dev, { ...base, ...query })).items.map((s) => s.key);

    expect(await keys({ q: 'db_' })).toEqual(['DB_HOST', 'DB_PASSWORD']);
    expect(await keys({ q: 'CREDENTIAL' })).toEqual(['DB_PASSWORD']);
    expect(await keys({ types: ['BOOLEAN', 'STRING'] })).toEqual(['DB_HOST', 'FEATURE_FLAG']);
    expect(await keys({ categories: ['none'] })).toEqual(['FEATURE_FLAG']);
    expect(await keys({ categories: ['Payments', 'none'] })).toEqual([
      'FEATURE_FLAG',
      'STRIPE_KEY',
    ]);
    expect(await keys({ tag: 'infra' })).toEqual(['DB_HOST', 'STRIPE_KEY']);
    expect(await keys({ sort: 'category' })).toEqual([
      'DB_HOST',
      'DB_PASSWORD',
      'STRIPE_KEY',
      'FEATURE_FLAG',
    ]);
    expect(await keys({ order: 'desc', take: 2 })).toEqual(['STRIPE_KEY', 'FEATURE_FLAG']);
    const page = await repos.secrets.list(dev, { ...base, skip: 2, take: 2 });
    expect(page).toMatchObject({
      total: 4,
      items: [{ key: 'FEATURE_FLAG' }, { key: 'STRIPE_KEY' }],
    });

    await expect(repos.secrets.facets(dev)).resolves.toEqual({
      categories: ['Database', 'Payments'],
      tags: ['billing', 'infra'],
    });
  });

  it('isolates tenants and environments', async () => {
    const { id } = await create('ISOLATED');
    const other = await createTenant(db, 'other');
    const foreign = createAuthorizedEnvironmentScope(
      other.workspaceId,
      other.projectId,
      other.developmentId,
    );
    // The id alone never grants access: scopes from elsewhere find nothing.
    const mixed = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.productionId);
    const repos = createRepositories(db);
    for (const scope of [foreign, mixed]) {
      await expect(repos.secrets.get(scope, id)).resolves.toBeNull();
      await expect(repos.secrets.currentVersion(scope, id)).resolves.toBeNull();
      await expect(repos.secrets.listVersions(scope, id)).resolves.toMatchObject({ items: [] });
      await expect(
        repos.secrets.update(scope, id, 1, { tags: ['x'] }, null, t.userId),
      ).resolves.toBeNull();
      await expect(repos.secrets.softDelete(scope, id, t.userId)).resolves.toBe(false);
    }
    expect((await repos.secrets.get(dev, id))?.tags).toEqual([]);
  });

  it('enforces organisation constraints in the database', async () => {
    await expectViolation(
      create('MANY_TAGS', dev, { tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) }),
      'check',
      'secrets_tags_count_chk',
    );
    await expectViolation(
      create('PADDED', dev, { category: ' Database' }),
      'check',
      'secrets_category_chk',
    );
  });
});

describe('EncryptionKeyRepository', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('registers one active key per workspace and demotes the previous one', async () => {
    const t = await createTenant(db, 'ek');
    const scope = createAuthorizedWorkspaceScope(t.workspaceId);
    const repos = createRepositories(db);
    await expect(repos.encryptionKeys.find(scope, 'local', 'local-abc')).resolves.toBeNull();
    const { id } = await withTransaction(db, (tx) =>
      createRepositories(tx).encryptionKeys.ensureActive(scope, 'local', 'local-abc'),
    );
    await expect(repos.encryptionKeys.find(scope, 'local', 'local-abc')).resolves.toEqual({ id });
    await expect(
      withTransaction(db, (tx) =>
        createRepositories(tx).encryptionKeys.ensureActive(scope, 'local', 'local-abc'),
      ),
    ).resolves.toEqual({ id });
    const rows = await db.encryptionKey.findMany({
      where: { workspaceId: t.workspaceId },
      orderBy: { version: 'asc' },
    });
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, 'DECRYPT_ONLY'],
      [2, 'ACTIVE'],
    ]);
  });

  it('gives concurrent registrations of the same key one shared row', async () => {
    const t = await createTenant(db, 'ek2');
    await db.encryptionKey.deleteMany({ where: { workspaceId: t.workspaceId } });
    const scope = createAuthorizedWorkspaceScope(t.workspaceId);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withTransaction(db, (tx) =>
          createRepositories(tx).encryptionKeys.ensureActive(scope, 'local', 'local-race'),
        ),
      ),
    );
    const ids = results.map((r) => (r.status === 'fulfilled' ? r.value.id : 'rejected'));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe('rejected');
    await expect(db.encryptionKey.count({ where: { workspaceId: t.workspaceId } })).resolves.toBe(
      1,
    );
    await expect(
      db.encryptionKey.count({ where: { workspaceId: t.workspaceId, status: 'ACTIVE' } }),
    ).resolves.toBe(1);
  });
});
