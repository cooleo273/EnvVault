import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repositories/index.js';
import { createAuthorizedWorkspaceScope } from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import {
  createTenant,
  disconnectTestDb,
  userData,
  role,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();
const repos = createRepositories(db);

describe('repositories', () => {
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    await truncateAll(db);
    a = await createTenant(db, 'repo-a');
    b = await createTenant(db, 'repo-b');
  });

  afterAll(disconnectTestDb);

  describe('MembershipRepository.findActiveMembership (authorization primitive)', () => {
    it('returns the role and its permissions for an active member', async () => {
      const membership = await repos.memberships.findActiveMembership(a.workspaceId, a.userId);
      expect(membership).toMatchObject({
        workspaceId: a.workspaceId,
        userId: a.userId,
        role: { key: 'owner', scope: 'WORKSPACE' },
      });
      expect(membership?.permissions).toContain('workspace:delete');
      // Workspace ownership alone never grants access to secret values.
      expect(membership?.permissions).not.toContain('secret:read');
    });

    it('denies by default: other workspace, suspended member, inactive user, deleted workspace', async () => {
      await expect(
        repos.memberships.findActiveMembership(b.workspaceId, a.userId),
      ).resolves.toBeNull();

      // A co-owner keeps the workspace owned while `a` is suspended.
      const coOwner = await db.user.create({ data: userData('co-owner@example.test') });
      await db.workspaceMembership.create({
        data: { workspaceId: a.workspaceId, userId: coOwner.id, roleId: role(a, 'owner') },
      });
      await db.workspaceMembership.update({
        where: { id: a.ownerMembershipId },
        data: { status: 'SUSPENDED' },
      });
      await expect(
        repos.memberships.findActiveMembership(a.workspaceId, a.userId),
      ).resolves.toBeNull();
      await db.workspaceMembership.update({
        where: { id: a.ownerMembershipId },
        data: { status: 'ACTIVE' },
      });

      await db.user.update({ where: { id: a.userId }, data: { status: 'SUSPENDED' } });
      await expect(
        repos.memberships.findActiveMembership(a.workspaceId, a.userId),
      ).resolves.toBeNull();
      await db.user.update({ where: { id: a.userId }, data: { status: 'ACTIVE' } });

      await db.workspace.update({ where: { id: a.workspaceId }, data: { deletedAt: new Date() } });
      await expect(
        repos.memberships.findActiveMembership(a.workspaceId, a.userId),
      ).resolves.toBeNull();
    });

    it('never grants secret values to the member or viewer roles', async () => {
      const user = await db.user.create({ data: userData('viewer@example.test') });
      await db.workspaceMembership.create({
        data: { workspaceId: a.workspaceId, userId: user.id, roleId: role(a, 'member') },
      });
      const membership = await repos.memberships.findActiveMembership(a.workspaceId, user.id);
      expect(membership?.permissions).not.toContain('secret:read');
      expect(membership?.permissions).not.toContain('secret:list');
    });
  });

  describe('tenant-scoped repositories', () => {
    it('cannot read another tenant’s project even with its id', async () => {
      const scopeA = createAuthorizedWorkspaceScope(a.workspaceId);
      await expect(repos.projects.findById(scopeA, a.projectId)).resolves.toMatchObject({
        id: a.projectId,
      });
      await expect(repos.projects.findById(scopeA, b.projectId)).resolves.toBeNull();
    });

    it('hides soft-deleted projects and their environments', async () => {
      const scope = createAuthorizedWorkspaceScope(a.workspaceId);
      await db.project.update({ where: { id: a.projectId }, data: { deletedAt: new Date() } });
      await expect(repos.projects.findBySlug(scope, 'project')).resolves.toBeNull();
      await expect(repos.environments.listByProject(scope, a.projectId)).resolves.toEqual([]);
    });

    it('lists only the scoped tenant’s environments in sort order', async () => {
      const scopeA = createAuthorizedWorkspaceScope(a.workspaceId);
      await db.environment.update({ where: { id: a.productionId }, data: { sortOrder: -1 } });

      const environments = await repos.environments.listByProject(scopeA, a.projectId);
      expect(environments.map((e) => e.slug)).toEqual(['production', 'development']);
      await expect(repos.environments.listByProject(scopeA, b.projectId)).resolves.toEqual([]);
      await expect(
        repos.environments.findBySlug(scopeA, b.projectId, 'production'),
      ).resolves.toBeNull();
    });

    it('works inside transactions with repositories bound to the transaction client', async () => {
      const scope = createAuthorizedWorkspaceScope(a.workspaceId);
      await expect(
        withTransaction(db, async (tx) => {
          const txRepos = createRepositories(tx);
          await tx.environment.create({
            data: { workspaceId: a.workspaceId, projectId: a.projectId, name: 'QA', slug: 'qa' },
          });
          // Visible inside the transaction...
          expect(await txRepos.environments.findBySlug(scope, a.projectId, 'qa')).not.toBeNull();
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      // ...and rolled back afterwards.
      await expect(repos.environments.findBySlug(scope, a.projectId, 'qa')).resolves.toBeNull();
    });
  });
});
