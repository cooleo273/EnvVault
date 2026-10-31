import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, it } from 'vitest';
import {
  createTenant,
  disconnectTestDb,
  expectTriggerRejection,
  expectViolation,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();
const bytes = (n: number) => new Uint8Array(randomBytes(n));

describe('deployment integration constraints', () => {
  let t: Tenant;
  let connectionId: string;

  beforeEach(async () => {
    await truncateAll(db);
    t = await createTenant(db, 'integrations');
    const connection = await db.integrationConnection.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        provider: 'VERCEL',
        name: 'Vercel',
        credentialCiphertext: bytes(40),
        credentialIv: bytes(12),
        credentialAuthTag: bytes(16),
        credentialEncryptedDataKey: bytes(61),
        credentialAlgorithm: 'AES_256_GCM',
        credentialEnvelopeVersion: 1,
        credentialKmsKeyVersion: 1,
        encryptionKeyId: t.encryptionKeyId,
      },
    });
    connectionId = connection.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const mapping = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: t.workspaceId,
    projectId: t.projectId,
    integrationConnectionId: connectionId,
    environmentId: t.developmentId,
    target: 'PREVIEW' as const,
    ...overrides,
  });

  it('keeps the credential envelope complete, and erased once disconnected', async () => {
    await expectViolation(
      db.integrationConnection.update({
        where: { id: connectionId },
        data: { credentialKmsKeyVersion: null },
      }),
      'check',
      'integration_connections_key_version_chk',
    );
    await expectViolation(
      db.integrationConnection.update({
        where: { id: connectionId },
        data: { disconnectedAt: new Date(), status: 'DISABLED' },
      }),
      'check',
      'integration_connections_disconnected_chk',
    );
    await expectTriggerRejection(
      db.integrationConnection.update({
        where: { id: connectionId },
        data: { provider: 'NETLIFY' },
      }),
      /provider is immutable/,
    );
  });

  it('checks targets and refuses duplicate mappings', async () => {
    await db.integrationEnvironmentMapping.create({ data: mapping() });
    await expectViolation(
      db.integrationEnvironmentMapping.create({ data: mapping({ environmentId: t.productionId }) }),
      'unique',
      'integration_mappings_target_key',
    );
    await db.integrationEnvironmentMapping.create({ data: mapping({ gitBranch: 'staging' }) });
    for (const [bad, constraint] of [
      [{ target: 'PRODUCTION', gitBranch: 'main' }, 'integration_mappings_target_chk'],
      [{ target: 'CUSTOM' }, 'integration_mappings_target_chk'],
      [{ target: 'PREVIEW', customEnvironmentId: 'env_x' }, 'integration_mappings_target_chk'],
      [{ gitBranch: 'a..b' }, 'integration_mappings_branch_chk'],
    ] as const) {
      await expectViolation(
        db.integrationEnvironmentMapping.create({ data: mapping(bad) }),
        'check',
        constraint,
      );
    }
  });

  it('ties a mapping to its connection and environment project', async () => {
    const other = await createTenant(db, 'integrations-other');
    await expectViolation(
      db.integrationEnvironmentMapping.create({
        data: mapping({ environmentId: other.developmentId }),
      }),
      'foreign_key',
    );
    const otherProject = await db.project.create({
      data: {
        workspaceId: t.workspaceId,
        name: 'Other',
        slug: `other-${randomBytes(3).toString('hex')}`,
      },
    });
    await expectViolation(
      db.integrationEnvironmentMapping.create({ data: mapping({ projectId: otherProject.id }) }),
      'foreign_key',
    );
  });

  it('allows one active job per mapping and keeps managed keys immutable', async () => {
    const created = await db.integrationEnvironmentMapping.create({ data: mapping() });
    const job = {
      workspaceId: t.workspaceId,
      integrationConnectionId: connectionId,
      projectId: t.projectId,
      environmentId: t.developmentId,
      mappingId: created.id,
      trigger: 'MANUAL' as const,
      status: 'RUNNING' as const,
      startedAt: new Date(),
    };
    await db.integrationSyncJob.create({ data: job });
    await expectViolation(
      db.integrationSyncJob.create({ data: job }),
      'unique',
      'integration_sync_jobs_active_key',
    );
    await db.integrationSyncJob.create({ data: { ...job, status: 'SUCCEEDED' } });
    const managed = await db.integrationManagedVariable.create({
      data: {
        workspaceId: t.workspaceId,
        mappingId: created.id,
        key: 'API_KEY',
        providerVariableId: 'env_1',
        providerUpdatedAt: 1n,
      },
    });
    await expectTriggerRejection(
      db.integrationManagedVariable.update({ where: { id: managed.id }, data: { key: 'OTHER' } }),
      /key is immutable/,
    );
    await expectViolation(
      db.integrationManagedVariable.create({
        data: {
          workspaceId: t.workspaceId,
          mappingId: created.id,
          key: 'bad key',
          providerVariableId: 'env_2',
          providerUpdatedAt: 1n,
        },
      }),
      'check',
      'integration_managed_variables_key_chk',
    );
  });
});
