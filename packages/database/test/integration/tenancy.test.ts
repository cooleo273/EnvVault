import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecret,
  createTenant,
  disconnectTestDb,
  userData,
  expectTriggerRejection,
  expectViolation,
  fakeEnvelope,
  role,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();

describe('tenant isolation constraints', () => {
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    await truncateAll(db);
    a = await createTenant(db, 'a');
    b = await createTenant(db, 'b');
  });

  afterAll(disconnectTestDb);

  it('rejects an environment whose project belongs to another workspace', async () => {
    await expectViolation(
      db.environment.create({
        data: { workspaceId: a.workspaceId, projectId: b.projectId, name: 'Leak', slug: 'leak' },
      }),
      'foreign_key',
      'environments_project_fkey',
    );
  });

  it('rejects a secret that points at another workspace environment', async () => {
    await expectViolation(
      db.secret.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: b.projectId,
          environmentId: b.developmentId,
          key: 'LEAK',
          createdByUserId: a.userId,
          updatedByUserId: a.userId,
        },
      }),
      'foreign_key',
      'secrets_environment_fkey',
    );
  });

  it('rejects a secret whose project does not own the environment', async () => {
    const other = await db.project.create({
      data: { workspaceId: a.workspaceId, name: 'Other', slug: 'other' },
    });
    await expectViolation(
      db.secret.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: other.id,
          environmentId: a.developmentId,
          key: 'MISMATCH',
          createdByUserId: a.userId,
          updatedByUserId: a.userId,
        },
      }),
      'foreign_key',
      'secrets_environment_fkey',
    );
  });

  it('rejects memberships that use a role from another workspace', async () => {
    const user = await db.user.create({ data: userData('mallory@example.test') });
    await expectViolation(
      db.workspaceMembership.create({
        data: { workspaceId: a.workspaceId, userId: user.id, roleId: role(b, 'owner') },
      }),
      'foreign_key',
      'workspace_memberships_role_fkey',
    );
  });

  it('rejects project access for a member of another workspace', async () => {
    await expectViolation(
      db.projectMembership.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          workspaceMembershipId: b.ownerMembershipId,
          roleId: role(a, 'project-viewer'),
        },
      }),
      'foreign_key',
      'project_memberships_member_fkey',
    );
  });

  it('rejects access policies for a service identity from another workspace', async () => {
    const identity = await db.serviceIdentity.create({
      data: { workspaceId: b.workspaceId, name: 'ci' },
    });
    await expectViolation(
      db.accessPolicy.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          environmentId: a.developmentId,
          serviceIdentityId: identity.id,
          roleId: role(a, 'environment-reader'),
        },
      }),
      'foreign_key',
      'access_policies_service_identity_fkey',
    );
  });

  it('rejects secret versions encrypted under another workspace key', async () => {
    const secret = await createSecret(db, a);
    await expectViolation(
      db.secretVersion.create({
        data: {
          workspaceId: a.workspaceId,
          secretId: secret.id,
          versionNumber: 1,
          encryptionKeyId: b.encryptionKeyId,
          createdByUserId: a.userId,
          ...fakeEnvelope(),
        },
      }),
      'foreign_key',
      'secret_versions_encryption_key_fkey',
    );
  });

  it('rejects secret attribution to another workspace service identity', async () => {
    const identity = await db.serviceIdentity.create({
      data: { workspaceId: b.workspaceId, name: 'ci' },
    });
    await expectViolation(
      db.secret.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          environmentId: a.developmentId,
          key: 'FROM_B',
          createdByServiceIdentityId: identity.id,
          updatedByServiceIdentityId: identity.id,
        },
      }),
      'foreign_key',
      'secrets_created_by_service_identity_fkey',
    );
  });

  it('prevents moving rows to another workspace or project', async () => {
    await expectTriggerRejection(
      db.project.update({ where: { id: a.projectId }, data: { workspaceId: b.workspaceId } }),
      /projects\.workspace_id is immutable/,
    );
    const other = await db.project.create({
      data: { workspaceId: a.workspaceId, name: 'Other', slug: 'other' },
    });
    await expectTriggerRejection(
      db.environment.update({ where: { id: a.developmentId }, data: { projectId: other.id } }),
      /environments\.project_id is immutable/,
    );
  });

  it('scopes environment slugs to their project and frees them on soft delete', async () => {
    // Same slug in another workspace's project is fine (fixtures already did this).
    await expectViolation(
      db.environment.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          name: 'Dev 2',
          slug: 'development',
        },
      }),
      'unique',
      'environments_project_slug_live_key',
    );
    await expectViolation(
      db.environment.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          name: 'DEVELOPMENT',
          slug: 'dev-2',
        },
      }),
      'unique',
      'environments_project_name_live_key',
    );

    await db.environment.update({
      where: { id: a.developmentId },
      data: { deletedAt: new Date() },
    });
    await expect(
      db.environment.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          name: 'Development',
          slug: 'development',
        },
      }),
    ).resolves.toMatchObject({ slug: 'development' });
  });

  it('enforces slug formats', async () => {
    await expectViolation(
      db.project.create({ data: { workspaceId: a.workspaceId, name: 'Bad', slug: 'Bad Slug' } }),
      'check',
      'projects_slug_format_chk',
    );
    await expectViolation(
      db.workspace.create({ data: { name: 'Bad', slug: '-leading-dash' } }),
      'check',
      'workspaces_slug_format_chk',
    );
  });

  it('keeps workspace slugs unique among live workspaces only', async () => {
    const slug = (await db.workspace.findUniqueOrThrow({ where: { id: a.workspaceId } })).slug;
    await expectViolation(
      db.workspace.create({ data: { name: 'Copy', slug } }),
      'unique',
      'workspaces_slug_live_key',
    );
    await db.workspace.update({ where: { id: a.workspaceId }, data: { deletedAt: new Date() } });
    await expect(db.workspace.create({ data: { name: 'Copy', slug } })).resolves.toBeDefined();
  });

  it('purges a workspace with all of its data and leaves other tenants intact', async () => {
    const secret = await createSecret(db, a);
    await db.secretVersion.create({
      data: {
        workspaceId: a.workspaceId,
        secretId: secret.id,
        versionNumber: 1,
        encryptionKeyId: a.encryptionKeyId,
        createdByUserId: a.userId,
        ...fakeEnvelope(),
      },
    });
    await createSecret(db, b);

    await db.workspace.delete({ where: { id: a.workspaceId } });

    for (const [model, count] of [
      [db.project.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.environment.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.secret.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.secretVersion.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.role.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.encryptionKey.count({ where: { workspaceId: a.workspaceId } }), 0],
      [db.secret.count({ where: { workspaceId: b.workspaceId } }), 1],
      [db.environment.count({ where: { workspaceId: b.workspaceId } }), 2],
    ] as const) {
      await expect(model).resolves.toBe(count);
    }
    // Users are global identities and survive the purge.
    await expect(db.user.count({ where: { id: a.userId } })).resolves.toBe(1);
  });
});
