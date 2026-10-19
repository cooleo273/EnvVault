import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionSystemRoles } from '../../src/catalog/provisioning.js';
import { SYSTEM_ROLES } from '../../src/catalog/roles.js';
import { createRepositories } from '../../src/repositories/index.js';
import { createAuthorizedWorkspaceScope } from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import {
  disconnectTestDb,
  expectTriggerRejection,
  expectViolation,
  testDb,
  truncateAll,
  userData,
} from './helpers.js';

const db = testDb();
const repos = createRepositories(db);

const identity = {
  authUserId: '7b0f3c52-9d1e-4f6a-8c2b-1a2b3c4d5e6f',
  email: 'Dev@Example.test',
  emailVerified: true,
  name: 'Dev User',
};

describe('Neon Auth identity link', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(disconnectTestDb);

  it('enforces one profile per Neon Auth identity and a safe id format', async () => {
    await db.user.create({ data: userData('a@example.test') });
    await expectViolation(
      db.user.create({
        data: { ...userData('b@example.test'), authUserId: 'test:a.at.example.test' },
      }),
      'unique',
      'users_auth_user_id_key',
    );
    await expectViolation(
      db.user.create({ data: { email: 'c@example.test', authUserId: 'has space' } }),
      'check',
      'users_auth_user_id_format_chk',
    );
  });

  it('never allows re-pointing a profile at another identity', async () => {
    const user = await db.user.create({ data: userData('a@example.test') });
    await expectTriggerRejection(
      db.user.update({ where: { id: user.id }, data: { authUserId: 'test:attacker' } }),
      /users\.auth_user_id is immutable/,
    );
  });

  it('allows the same cached email on different identities (Neon Auth owns uniqueness)', async () => {
    await db.user.create({ data: { email: 'shared@example.test', authUserId: 'id-1' } });
    await expect(
      db.user.create({ data: { email: 'shared@example.test', authUserId: 'id-2' } }),
    ).resolves.toBeDefined();
  });

  describe('UserRepository.upsertFromIdentity', () => {
    it('provisions a profile on first use and normalises the email', async () => {
      const profile = await repos.users.upsertFromIdentity(identity);
      expect(profile).toMatchObject({
        authUserId: identity.authUserId,
        email: 'dev@example.test',
        displayName: 'Dev User',
        emailVerified: true,
        status: 'ACTIVE',
        deleted: false,
      });
      await expect(db.user.count()).resolves.toBe(1);
    });

    it('refreshes cached fields from later verified tokens', async () => {
      await repos.users.upsertFromIdentity({ ...identity, emailVerified: false });
      const updated = await repos.users.upsertFromIdentity({
        ...identity,
        email: 'new@example.test',
        name: 'Renamed',
      });
      expect(updated).toMatchObject({
        email: 'new@example.test',
        displayName: 'Renamed',
        emailVerified: true,
      });
      await expect(db.user.count()).resolves.toBe(1);
    });

    it('is safe under concurrent first requests', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repos.users.upsertFromIdentity(identity)),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      await expect(db.user.count()).resolves.toBe(1);
    });

    it('never re-activates a suspended or deleted profile', async () => {
      const profile = await repos.users.upsertFromIdentity(identity);
      await db.user.update({ where: { id: profile.id }, data: { status: 'SUSPENDED' } });
      await expect(repos.users.upsertFromIdentity(identity)).resolves.toMatchObject({
        status: 'SUSPENDED',
      });
      await db.user.update({ where: { id: profile.id }, data: { deletedAt: new Date() } });
      await expect(repos.users.upsertFromIdentity(identity)).resolves.toMatchObject({
        deleted: true,
      });
    });
  });
});

describe('AuthStateRepository', () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAll(db);
    userId = (await db.user.create({ data: userData('state@example.test') })).id;
  });

  it('records a monotonic token revocation boundary', async () => {
    await expect(repos.authState.getTokensNotBefore(userId)).resolves.toBeNull();
    const later = new Date('2026-10-19T12:00:00Z');
    const earlier = new Date('2026-10-19T11:00:00Z');

    await repos.authState.revokeTokensIssuedBefore(userId, 'LOGOUT', later);
    await repos.authState.revokeTokensIssuedBefore(userId, 'PASSWORD_CHANGED', earlier);

    await expect(repos.authState.getTokensNotBefore(userId)).resolves.toEqual(later);
    await expect(
      db.authTokenRevocation.findUniqueOrThrow({ where: { userId } }),
    ).resolves.toMatchObject({
      reason: 'LOGOUT',
    });
  });

  it('grants, finds and clears short-lived step-up grants', async () => {
    const now = new Date();
    const { expiresAt } = await repos.authState.createStepUpGrant(userId, 'PASSWORD', 600, now);
    await expect(repos.authState.findActiveStepUpExpiry(userId, now)).resolves.toEqual(expiresAt);
    await expect(
      repos.authState.findActiveStepUpExpiry(userId, new Date(expiresAt.getTime() + 1)),
    ).resolves.toBeNull();

    await repos.authState.clearStepUpGrants(userId);
    await expect(repos.authState.findActiveStepUpExpiry(userId, now)).resolves.toBeNull();
  });

  it('bounds step-up grant lifetimes in the application and the database', async () => {
    await expect(repos.authState.createStepUpGrant(userId, 'PASSWORD', 7200)).rejects.toThrow(
      /TTL/,
    );
    const now = new Date();
    await expectViolation(
      db.authStepUpGrant.create({
        data: {
          userId,
          method: 'PASSWORD',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 2 * 3600_000),
        },
      }),
      'check',
      'auth_step_up_grants_lifetime_chk',
    );
  });

  it('removes auth state together with the profile', async () => {
    await repos.authState.revokeTokensIssuedBefore(userId, 'LOGOUT');
    await repos.authState.createStepUpGrant(userId, 'PASSWORD', 60);
    await db.user.delete({ where: { id: userId } });
    await expect(db.authTokenRevocation.count()).resolves.toBe(0);
    await expect(db.authStepUpGrant.count()).resolves.toBe(0);
  });
});

describe('WorkspaceRepository', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('creates a workspace whose creator is an owner with every permission', async () => {
    const owner = await db.user.create({ data: userData('owner@example.test') });
    const workspace = await withTransaction(db, (tx) =>
      createRepositories(tx).workspaces.createWithOwner({
        name: 'Acme',
        slug: 'acme',
        ownerUserId: owner.id,
      }),
    );
    const membership = await repos.memberships.findActiveMembership(workspace.id, owner.id);
    expect(membership?.role.key).toBe('owner');
    expect(membership?.permissions).toContain('workspace:delete');
    await expect(repos.workspaces.listForUser(owner.id)).resolves.toMatchObject([
      { id: workspace.id, slug: 'acme', role: { key: 'owner' } },
    ]);
  });

  it('provisions the same roles and grants as the per-role realignment path', async () => {
    const owner = await db.user.create({ data: userData('owner@example.test') });
    const fast = await withTransaction(db, (tx) =>
      createRepositories(tx).workspaces.createWithOwner({
        name: 'Fast',
        slug: 'fast',
        ownerUserId: owner.id,
      }),
    );
    const grants = async (workspaceId: string) =>
      (
        await db.rolePermission.findMany({
          where: { role: { workspaceId } },
          select: { role: { select: { key: true } }, permission: { select: { key: true } } },
        })
      )
        .map((g) => `${g.role.key}:${g.permission.key}`)
        .sort();
    const before = await grants(fast.id);
    expect(before.length).toBeGreaterThan(0);

    // Realigning with the slower per-role path must change nothing.
    await withTransaction(db, (tx) => provisionSystemRoles(tx, fast.id));
    expect(await grants(fast.id)).toEqual(before);
    expect(await db.role.count({ where: { workspaceId: fast.id } })).toBe(SYSTEM_ROLES.length);
  });

  it('lists only live workspaces with an active membership for that user', async () => {
    const alice = await db.user.create({ data: userData('alice@example.test') });
    const bob = await db.user.create({ data: userData('bob@example.test') });
    const create = (slug: string, ownerUserId: string) =>
      withTransaction(db, (tx) =>
        createRepositories(tx).workspaces.createWithOwner({ name: slug, slug, ownerUserId }),
      );
    const a1 = await create('alice-one', alice.id);
    const a2 = await create('alice-two', alice.id);
    await create('bob-one', bob.id);

    await repos.workspaces.softDelete(createAuthorizedWorkspaceScope(a2.id));
    expect((await repos.workspaces.listForUser(alice.id)).map((w) => w.slug)).toEqual([
      'alice-one',
    ]);

    // Bob co-owns alice-one so that suspending Alice leaves it with an owner.
    const ownerRole = await db.role.findFirstOrThrow({
      where: { workspaceId: a1.id, key: 'owner' },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: a1.id, userId: bob.id, roleId: ownerRole.id },
    });
    await db.workspaceMembership.updateMany({
      where: { workspaceId: a1.id, userId: alice.id },
      data: { status: 'SUSPENDED' },
    });
    await expect(repos.workspaces.listForUser(alice.id)).resolves.toEqual([]);
  });

  it('soft-deletes once and hides the workspace afterwards', async () => {
    const owner = await db.user.create({ data: userData('owner@example.test') });
    const ws = await withTransaction(db, (tx) =>
      createRepositories(tx).workspaces.createWithOwner({
        name: 'Gone',
        slug: 'gone',
        ownerUserId: owner.id,
      }),
    );
    const scope = createAuthorizedWorkspaceScope(ws.id);
    await expect(repos.workspaces.getDetail(scope)).resolves.toMatchObject({
      memberCount: 1,
      projectCount: 0,
    });
    await expect(repos.workspaces.softDelete(scope)).resolves.toBe(true);
    await expect(repos.workspaces.softDelete(scope)).resolves.toBe(false);
    await expect(repos.workspaces.getDetail(scope)).resolves.toBeNull();
  });

  it('appends audit events', async () => {
    const owner = await db.user.create({ data: userData('owner@example.test') });
    await repos.audit.append({
      actorUserId: owner.id,
      action: 'auth.step_up.succeeded',
      outcome: 'SUCCESS',
      resourceType: 'user',
      resourceId: owner.id,
      metadata: { method: 'PASSWORD' },
    });
    await expect(db.auditEvent.count()).resolves.toBe(1);
  });
});
