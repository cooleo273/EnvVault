import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, type NewSecretVersion } from '../../src/repositories/index.js';
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
let t: Tenant;
let dev: EnvironmentScope;
let prod: EnvironmentScope;

function version(): NewSecretVersion {
  return {
    id: randomUUID(),
    encryptionKeyId: t.encryptionKeyId,
    kmsKeyVersion: '1',
    envelopeVersion: 1,
    origin: 'CREATE',
    ...fakeEnvelope(),
  };
}

async function secret(
  scope: EnvironmentScope,
  key: string,
  inheritable = false,
  type: 'STRING' | 'SECRET' = 'STRING',
) {
  return withTransaction(db, (tx) =>
    createRepositories(tx).secrets.create(
      scope,
      {
        id: randomUUID(),
        key,
        description: null,
        type,
        category: null,
        tags: [],
        isRequired: false,
        inheritable,
      },
      version(),
      t.userId,
    ),
  );
}

async function environment(name: string, projectId = t.projectId) {
  return db.environment.create({
    data: { workspaceId: t.workspaceId, projectId, name, slug: name.toLowerCase() },
  });
}

beforeEach(async () => {
  await truncateAll(db);
  t = await createTenant(db, 'intel');
  dev = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.developmentId);
  prod = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, t.productionId);
});

afterAll(disconnectTestDb);

describe('inheritance constraints', () => {
  it('allows one level within a project and rejects self, chains and cycles', async () => {
    const qa = await environment('QA');
    const staging = await environment('Staging');
    const qaScope = createAuthorizedEnvironmentScope(t.workspaceId, t.projectId, qa.id);
    await withTransaction(db, (tx) =>
      createRepositories(tx).environments.setBase(qaScope, t.developmentId),
    );
    expect(
      (await db.environment.findUniqueOrThrow({ where: { id: qa.id } })).baseEnvironmentId,
    ).toBe(t.developmentId);

    await expectViolation(
      db.environment.update({ where: { id: staging.id }, data: { baseEnvironmentId: staging.id } }),
      'check',
      'environments_base_not_self_chk',
    );
    // Staging -> QA would make a chain (QA already inherits).
    await expectTriggerRejection(
      db.environment.update({ where: { id: staging.id }, data: { baseEnvironmentId: qa.id } }),
      /cannot itself inherit/,
    );
    // Development is a base, so it cannot inherit (that would allow a cycle).
    await expectTriggerRejection(
      db.environment.update({ where: { id: t.developmentId }, data: { baseEnvironmentId: qa.id } }),
      /cannot inherit/,
    );
  });

  it('rejects a base from another project', async () => {
    const other = await db.project.create({
      data: { workspaceId: t.workspaceId, name: 'Other', slug: 'other' },
    });
    const foreign = await environment('Foreign', other.id);
    await expectViolation(
      db.environment.update({
        where: { id: t.developmentId },
        data: { baseEnvironmentId: foreign.id },
      }),
      'foreign_key',
      'environments_base_environment_fkey',
    );
  });

  it('never stores an inheritable SECRET', async () => {
    await expectViolation(
      secret(dev, 'TOKEN', true, 'SECRET'),
      'check',
      'secrets_inheritable_not_secret_chk',
    );
    const { id } = await secret(dev, 'LOG_LEVEL', true);
    await expectViolation(
      db.secret.update({ where: { id }, data: { type: 'SECRET' } }),
      'check',
      'secrets_inheritable_not_secret_chk',
    );
  });
});

describe('snapshots', () => {
  async function capture(scope: EnvironmentScope) {
    const repos = createRepositories(db);
    const rows = await repos.secretBulk.variables(scope, 100);
    return withTransaction(db, (tx) =>
      createRepositories(tx).snapshots.create(
        scope,
        {
          id: randomUUID(),
          description: 'before release',
          baseEnvironmentId: null,
          entries: rows.map((r) => ({
            secretId: r.id,
            secretVersionId: r.currentVersionId,
            versionNumber: r.currentVersionNumber,
            key: r.key,
            type: r.type,
            category: r.category,
            tags: r.tags,
            isRequired: r.isRequired,
            inheritable: r.inheritable,
            description: r.description,
          })),
        },
        t.userId,
      ),
    );
  }

  it('records exact versions and is immutable', async () => {
    await secret(dev, 'A');
    await secret(dev, 'B', true);
    const snapshot = await capture(dev);
    const repos = createRepositories(db);
    expect(snapshot).toMatchObject({ entryCount: 2, status: 'COMPLETE', schemaVersion: 1 });
    const entries = await repos.snapshots.entries(dev, snapshot.id);
    expect(entries.map((e) => [e.key, e.versionNumber, e.inheritable])).toEqual([
      ['A', 1, false],
      ['B', 1, true],
    ]);
    await expect(repos.snapshots.entries(prod, snapshot.id)).resolves.toEqual([]);
    await expect(repos.snapshots.get(prod, snapshot.id)).resolves.toBeNull();

    await expectTriggerRejection(
      db.environmentSnapshot.update({
        where: { id: snapshot.id },
        data: { description: 'edited' },
      }),
      /immutable/,
    );
    const entry = await db.environmentSnapshotEntry.findFirstOrThrow({
      where: { snapshotId: snapshot.id },
    });
    await expectTriggerRejection(
      db.environmentSnapshotEntry.update({ where: { id: entry.id }, data: { key: 'C' } }),
      /immutable/,
    );
    // No value or ciphertext columns exist on snapshot tables.
    const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('environment_snapshots', 'environment_snapshot_entries')`,
    );
    expect(columns.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining(['value', 'ciphertext', 'encrypted_data_key', 'iv', 'auth_tag']),
    );
  });

  it('cannot reference a secret of another environment or a version of another secret', async () => {
    await secret(dev, 'A');
    const prodSecret = await secret(prod, 'P');
    const snapshot = await capture(dev);
    const prodVersion = await db.secretVersion.findFirstOrThrow({
      where: { secretId: prodSecret.id },
    });
    const later = await secret(dev, 'LATER');
    const base = {
      workspaceId: t.workspaceId,
      snapshotId: snapshot.id,
      environmentId: t.developmentId,
      type: 'STRING' as const,
      isRequired: false,
      inheritable: false,
      tags: [],
    };
    await expectViolation(
      db.environmentSnapshotEntry.create({ data: { ...base, secretId: prodSecret.id, key: 'P' } }),
      'foreign_key',
      'environment_snapshot_entries_secret_fkey',
    );
    await expectViolation(
      db.environmentSnapshotEntry.create({
        data: {
          ...base,
          secretId: later.id,
          key: 'X',
          secretVersionId: prodVersion.id,
          versionNumber: 1,
        },
      }),
      'foreign_key',
      'environment_snapshot_entries_version_fkey',
    );
  });
});

describe('validation rules', () => {
  it('replaces the rule set and enforces rule constraints', async () => {
    const repos = createRepositories(db);
    const rule = {
      key: 'PORT',
      required: true,
      allowEmpty: false,
      format: 'NUMBER' as const,
      minNumber: 1,
      maxNumber: 65535,
      minLength: null,
      maxLength: null,
      pattern: null,
      allowedValues: [],
      description: null,
    };
    await withTransaction(db, (tx) =>
      createRepositories(tx).validationRules.replace(dev, [rule], t.userId),
    );
    expect(await repos.validationRules.list(dev)).toMatchObject([
      { key: 'PORT', minNumber: 1, maxNumber: 65535 },
    ]);
    await withTransaction(db, (tx) =>
      createRepositories(tx).validationRules.replace(dev, [], t.userId),
    );
    expect(await repos.validationRules.list(dev)).toEqual([]);
    await expectViolation(
      withTransaction(db, (tx) =>
        createRepositories(tx).validationRules.replace(
          dev,
          [{ ...rule, key: '*', pattern: null, required: false }],
          t.userId,
        ),
      ),
      'check',
      'configuration_validation_rules_naming_chk',
    );
    await expectViolation(
      withTransaction(db, (tx) =>
        createRepositories(tx).validationRules.replace(
          dev,
          [{ ...rule, minNumber: 10, maxNumber: 1 }],
          t.userId,
        ),
      ),
      'check',
      'configuration_validation_rules_number_chk',
    );
  });
});
