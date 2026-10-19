import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/client.js';
import { withTransaction } from '../../src/transaction.js';
import {
  createSecret,
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

/**
 * Reference implementation of the version-write pattern Phase 1 will use:
 * allocate the next version number with a row-locking UPDATE, insert the
 * encrypted version, and move the current pointer, all in one transaction.
 */
async function appendVersion(tx: DbClient, tenant: Tenant, secretId: string) {
  const secret = await tx.secret.update({
    where: { id: secretId },
    data: { latestVersionNumber: { increment: 1 }, updatedByUserId: tenant.userId },
    select: { latestVersionNumber: true },
  });
  const version = await tx.secretVersion.create({
    data: {
      workspaceId: tenant.workspaceId,
      secretId,
      versionNumber: secret.latestVersionNumber,
      encryptionKeyId: tenant.encryptionKeyId,
      createdByUserId: tenant.userId,
      ...fakeEnvelope(),
    },
  });
  await tx.secret.update({ where: { id: secretId }, data: { currentVersionId: version.id } });
  return version;
}

describe('secret storage constraints', () => {
  let t: Tenant;

  beforeEach(async () => {
    await truncateAll(db);
    t = await createTenant(db, 's');
  });

  afterAll(disconnectTestDb);

  it('accepts environment-variable style keys only', async () => {
    await expect(createSecret(db, t, 'STRIPE_API_KEY_2')).resolves.toBeDefined();
    for (const key of ['my-key', '1ABC', 'HAS SPACE', '']) {
      await expectViolation(createSecret(db, t, key), 'check', 'secrets_key_format_chk');
    }
  });

  it('keeps keys unique per environment among live secrets', async () => {
    const first = await createSecret(db, t, 'TOKEN');
    await expectViolation(
      createSecret(db, t, 'TOKEN'),
      'unique',
      'secrets_environment_key_live_key',
    );
    // Same key in another environment is fine.
    await expect(createSecret(db, t, 'TOKEN', t.productionId)).resolves.toBeDefined();
    // Soft-deleting frees the key.
    await db.secret.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await expect(createSecret(db, t, 'TOKEN')).resolves.toBeDefined();
  });

  it('requires exactly one creating principal', async () => {
    const base = {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      environmentId: t.developmentId,
      updatedByUserId: t.userId,
    };
    await expectViolation(
      db.secret.create({ data: { ...base, key: 'NOBODY' } }),
      'check',
      'secrets_created_by_one_principal_chk',
    );
    const identity = await db.serviceIdentity.create({
      data: { workspaceId: t.workspaceId, name: 'ci' },
    });
    await expectViolation(
      db.secret.create({
        data: {
          ...base,
          key: 'BOTH',
          createdByUserId: t.userId,
          createdByServiceIdentityId: identity.id,
        },
      }),
      'check',
      'secrets_created_by_one_principal_chk',
    );
  });

  it('writes versions atomically and tracks the current version', async () => {
    const secret = await createSecret(db, t);
    await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));
    const v2 = await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));

    const stored = await db.secret.findUniqueOrThrow({
      where: { id: secret.id },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
    });
    expect(stored.latestVersionNumber).toBe(2);
    expect(stored.currentVersionId).toBe(v2.id);
    expect(stored.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('rolls back every write when the transaction fails', async () => {
    const secret = await createSecret(db, t);
    await expect(
      withTransaction(db, async (tx) => {
        await appendVersion(tx, t, secret.id);
        throw new Error('KMS unavailable');
      }),
    ).rejects.toThrow('KMS unavailable');

    const stored = await db.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(stored.latestVersionNumber).toBe(0);
    expect(stored.currentVersionId).toBeNull();
    await expect(db.secretVersion.count()).resolves.toBe(0);
  });

  it('only allows a current version that belongs to the same secret', async () => {
    const a = await createSecret(db, t, 'A');
    const b = await createSecret(db, t, 'B');
    // Use a non-current version of B so the UNIQUE(current_version_id) constraint
    // does not fire first; the composite FK must reject it on its own.
    const versionOfB = await withTransaction(db, (tx) => appendVersion(tx, t, b.id));
    await withTransaction(db, (tx) => appendVersion(tx, t, b.id));
    await db.secret.update({ where: { id: a.id }, data: { latestVersionNumber: 1 } });

    await expectViolation(
      db.secret.update({ where: { id: a.id }, data: { currentVersionId: versionOfB.id } }),
      'foreign_key',
      'secrets_current_version_fkey',
    );
  });

  it('rejects duplicate version numbers and malformed envelopes', async () => {
    const secret = await createSecret(db, t);
    await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));
    const base = {
      workspaceId: t.workspaceId,
      secretId: secret.id,
      encryptionKeyId: t.encryptionKeyId,
      createdByUserId: t.userId,
    };
    await expectViolation(
      db.secretVersion.create({ data: { ...base, versionNumber: 1, ...fakeEnvelope() } }),
      'unique',
    );
    await expectViolation(
      db.secretVersion.create({
        data: { ...base, versionNumber: 2, ...fakeEnvelope(), iv: new Uint8Array(8) },
      }),
      'check',
      'secret_versions_iv_len_chk',
    );
    await expectViolation(
      db.secretVersion.create({
        data: { ...base, versionNumber: 2, ...fakeEnvelope(), authTag: new Uint8Array(4) },
      }),
      'check',
      'secret_versions_auth_tag_len_chk',
    );
  });

  it('makes the encrypted payload immutable but allows re-wrapping the data key', async () => {
    const secret = await createSecret(db, t);
    const version = await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));

    await expectTriggerRejection(
      db.secretVersion.update({
        where: { id: version.id },
        data: { ciphertext: new Uint8Array(4) },
      }),
      /secret_versions\.ciphertext is immutable/,
    );
    await expectTriggerRejection(
      db.secretVersion.update({ where: { id: version.id }, data: { versionNumber: 9 } }),
      /secret_versions\.version_number is immutable/,
    );

    // Key rotation: retire v1 to DECRYPT_ONLY, activate v2, re-wrap the data key.
    await db.encryptionKey.update({
      where: { id: t.encryptionKeyId },
      data: { status: 'DECRYPT_ONLY' },
    });
    const v2 = await db.encryptionKey.create({
      data: {
        workspaceId: t.workspaceId,
        version: 2,
        kmsProvider: 'test',
        kmsKeyRef: 'test-key-v2',
      },
    });
    const rewrapped = await db.secretVersion.update({
      where: { id: version.id },
      data: {
        encryptionKeyId: v2.id,
        encryptedDataKey: fakeEnvelope().encryptedDataKey,
        rewrappedAt: new Date(),
      },
    });
    expect(rewrapped.encryptionKeyId).toBe(v2.id);
    expect(Buffer.from(rewrapped.ciphertext).equals(Buffer.from(version.ciphertext))).toBe(true);
  });

  it('allows only one active encryption key per workspace', async () => {
    await expectViolation(
      db.encryptionKey.create({
        data: { workspaceId: t.workspaceId, version: 2, kmsProvider: 'test', kmsKeyRef: 'another' },
      }),
      'unique',
      'encryption_keys_one_active_key',
    );
  });

  it('prevents deleting an encryption key still used by secret versions', async () => {
    const secret = await createSecret(db, t);
    await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));
    await expectViolation(
      db.encryptionKey.delete({ where: { id: t.encryptionKeyId } }),
      'foreign_key',
      'secret_versions_encryption_key_fkey',
    );
  });

  it('cascades a secret purge to its version history', async () => {
    const secret = await createSecret(db, t);
    await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));
    await withTransaction(db, (tx) => appendVersion(tx, t, secret.id));

    await db.secret.delete({ where: { id: secret.id } });
    await expect(db.secretVersion.count({ where: { secretId: secret.id } })).resolves.toBe(0);
  });

  it('validates rotation policies', async () => {
    const secret = await createSecret(db, t);
    await expectViolation(
      db.secretRotationPolicy.create({
        data: { workspaceId: t.workspaceId, secretId: secret.id, intervalDays: 0 },
      }),
      'check',
      'secret_rotation_policies_interval_chk',
    );
    await expectViolation(
      db.secretRotationPolicy.create({
        data: {
          workspaceId: t.workspaceId,
          secretId: secret.id,
          intervalDays: 30,
          strategy: 'INTEGRATION',
        },
      }),
      'check',
      'secret_rotation_policies_integration_chk',
    );
  });
});
