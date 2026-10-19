import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncAllWorkspaceRoles } from '../../src/catalog/provisioning.js';
import { SYSTEM_ROLES } from '../../src/catalog/roles.js';
import { getConstraintViolation } from '../../src/errors.js';
import { createRepositories, effectiveInvitationStatus } from '../../src/repositories/index.js';
import { slugify } from '../../src/repositories/workspace.repository.js';
import { createAuthorizedWorkspaceScope } from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import { disconnectTestDb, testDb, truncateAll, userData } from './helpers.js';

const db = testDb();
const repos = createRepositories(db);

async function newWorkspace(ownerEmail: string, slug: string) {
  const owner = await db.user.create({ data: userData(ownerEmail) });
  const ws = await withTransaction(db, (tx) =>
    createRepositories(tx).workspaces.createWithOwner({
      name: slug,
      slug,
      ownerUserId: owner.id,
      type: 'TEAM',
    }),
  );
  const scope = createAuthorizedWorkspaceScope(ws.id);
  const roleId = async (key: string) => {
    const found = await repos.roles.findWorkspaceRole(scope, key);
    if (!found) throw new Error(`missing role ${key}`);
    return found.id;
  };
  const ownerMembership = await repos.memberships.findActiveMembership(ws.id, owner.id);
  if (!ownerMembership) throw new Error('owner membership missing');
  return { owner, ws, scope, roleId, ownerMembershipId: ownerMembership.membershipId };
}

function tokenHash(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(randomBytes(32)).digest());
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => {
      throw new Error('expected the database to reject the change');
    },
    (error: unknown) => error,
  );
}

describe('workspace lifecycle', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(disconnectTestDb);

  it('generates slugs from names', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
    expect(slugify('  Ünïcode — Team!! ')).toBe('unicode-team');
    expect(slugify('***')).toBe('workspace');
    expect(slugify('a'.repeat(80))).toHaveLength(48);
  });

  it('stores type and description, and archives and restores exactly once', async () => {
    const { scope, owner } = await newWorkspace('o@example.test', 'life');
    expect(await repos.workspaces.update(scope, { description: '  Billing team  ' })).toBe(true);
    expect((await repos.workspaces.getDetail(scope))?.description).toBe('Billing team');
    expect(await repos.workspaces.update(scope, { description: '' })).toBe(true);
    expect((await repos.workspaces.getDetail(scope))?.description).toBeNull();

    expect(await repos.workspaces.archive(scope)).toBe(true);
    expect(await repos.workspaces.archive(scope)).toBe(false);
    // Archived workspaces are read-only and hidden from the default list.
    expect(await repos.workspaces.update(scope, { name: 'Renamed' })).toBe(false);
    expect(await repos.workspaces.listForUser(owner.id)).toEqual([]);
    expect(await repos.workspaces.listForUser(owner.id, { includeArchived: true })).toHaveLength(1);
    expect(
      (await repos.memberships.findActiveMembership(scope.workspaceId, owner.id))
        ?.workspaceArchived,
    ).toBe(true);

    expect(await repos.workspaces.restore(scope)).toBe(true);
    expect(await repos.workspaces.restore(scope)).toBe(false);
    expect(await repos.workspaces.listForUser(owner.id)).toHaveLength(1);
  });

  it('rejects blank descriptions at the database level', async () => {
    const { ws } = await newWorkspace('o@example.test', 'blank');
    const error = await rejectionOf(
      db.workspace.update({ where: { id: ws.id }, data: { description: '   ' } }),
    );
    expect(getConstraintViolation(error)?.constraint).toBe('workspaces_description_not_blank_chk');
  });

  it('never grants project, environment or secret permissions through workspace roles', () => {
    const workspaceRoles = SYSTEM_ROLES.filter((r) => r.scope === 'WORKSPACE');
    expect(workspaceRoles.map((r) => r.key)).toEqual(['owner', 'admin', 'member', 'viewer']);
    for (const definition of workspaceRoles) {
      for (const key of definition.permissions) {
        expect(key).toMatch(/^(workspace|member|role|audit):/);
      }
    }
  });

  it('realigns built-in roles of existing workspaces and removes stale grants', async () => {
    const { scope } = await newWorkspace('o@example.test', 'legacy');
    const ownerRole = await repos.roles.findWorkspaceRole(scope, 'owner');
    const secretRead = await db.permission.findUniqueOrThrow({ where: { key: 'secret:read' } });
    // Simulate a workspace created before Phase 1, whose owner role could read secrets.
    await db.rolePermission.create({
      data: { roleId: ownerRole?.id ?? '', permissionId: secretRead.id },
    });
    await db.role.deleteMany({ where: { workspaceId: scope.workspaceId, key: 'viewer' } });

    await expect(syncAllWorkspaceRoles(db)).resolves.toEqual({ workspaces: 1 });
    const grants = await db.rolePermission.count({
      where: { roleId: ownerRole?.id ?? '', permission: { key: 'secret:read' } },
    });
    expect(grants).toBe(0);
    expect(await repos.roles.findWorkspaceRole(scope, 'viewer')).not.toBeNull();
    // Idempotent.
    await expect(syncAllWorkspaceRoles(db)).resolves.toEqual({ workspaces: 1 });
  });
});

describe('final owner invariant (database trigger)', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('refuses to delete or demote the last owner', async () => {
    const { scope, ownerMembershipId, roleId } = await newWorkspace('o@example.test', 'solo');
    const removed = await rejectionOf(repos.memberships.remove(scope, ownerMembershipId));
    expect(getConstraintViolation(removed)?.constraint).toBe('workspace_memberships_last_owner');

    const demoted = await rejectionOf(
      repos.memberships.setRole(scope, ownerMembershipId, await roleId('admin')),
    );
    expect(getConstraintViolation(demoted)?.constraint).toBe('workspace_memberships_last_owner');
    expect(await repos.memberships.countActiveOwners(scope)).toBe(1);
  });

  it('allows transferring ownership within one transaction', async () => {
    const { scope, ownerMembershipId, roleId } = await newWorkspace('o@example.test', 'transfer');
    const next = await db.user.create({ data: userData('next@example.test') });
    const nextMembership = await repos.memberships.add(scope, next.id, await roleId('member'));

    await withTransaction(db, async (tx) => {
      const r = createRepositories(tx);
      await r.workspaces.lockForUpdate(scope);
      await r.memberships.setRole(scope, ownerMembershipId, await roleId('admin'));
      await r.memberships.setRole(scope, nextMembership, await roleId('owner'));
    });
    expect(await repos.memberships.countActiveOwners(scope)).toBe(1);
    expect((await repos.memberships.findMember(scope, nextMembership))?.role.key).toBe('owner');
  });

  it('rolls back a transaction that would end with no owner', async () => {
    const { scope, ownerMembershipId, roleId } = await newWorkspace('o@example.test', 'rollback');
    const error = await rejectionOf(
      withTransaction(db, async (tx) => {
        await createRepositories(tx).memberships.setRole(
          scope,
          ownerMembershipId,
          await roleId('admin'),
        );
      }),
    );
    expect(String(error)).toMatch(/workspace_memberships_last_owner/);
    expect(await repos.memberships.countActiveOwners(scope)).toBe(1);
  });

  it('serialises concurrent removal of two owners so one owner always remains', async () => {
    const { scope, ownerMembershipId, roleId } = await newWorkspace('o@example.test', 'race');
    const second = await db.user.create({ data: userData('second@example.test') });
    const secondMembership = await repos.memberships.add(scope, second.id, await roleId('owner'));

    const results = await Promise.allSettled([
      withTransaction(db, (tx) =>
        createRepositories(tx).memberships.remove(scope, ownerMembershipId),
      ),
      withTransaction(db, (tx) =>
        createRepositories(tx).memberships.remove(scope, secondMembership),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await repos.memberships.countActiveOwners(scope)).toBe(1);
  });

  it('does not block deleting a workspace with its memberships', async () => {
    const { ws } = await newWorkspace('o@example.test', 'purge');
    await db.workspace.delete({ where: { id: ws.id } });
    expect(await db.workspaceMembership.count({ where: { workspaceId: ws.id } })).toBe(0);
  });
});

describe('invitations', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('is single use: accept, decline and revoke succeed at most once', async () => {
    const { scope, owner, roleId } = await newWorkspace('o@example.test', 'invites');
    const invitee = await db.user.create({ data: userData('guest@example.test') });
    const hash = tokenHash();
    const invitation = await repos.invitations.create(scope, {
      email: 'guest@example.test',
      roleId: await roleId('member'),
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: owner.id,
    });
    expect(await repos.invitations.hasPending(scope, 'guest@example.test')).toBe(true);
    expect((await repos.invitations.findUsableByTokenHash(hash))?.id).toBe(invitation.id);

    const [first, second] = await Promise.all([
      repos.invitations.markAccepted(invitation.id, invitee.id),
      repos.invitations.markAccepted(invitation.id, invitee.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // Replay: the token no longer resolves and cannot be declined or revoked.
    expect(await repos.invitations.findUsableByTokenHash(hash)).toBeNull();
    expect(await repos.invitations.markDeclined(invitation.id)).toBe(false);
    expect(await repos.invitations.revoke(scope, invitation.id)).toBe(false);
  });

  it('treats expired invitations as unusable and lets a new one replace them', async () => {
    const { scope, owner, roleId } = await newWorkspace('o@example.test', 'expiry');
    const createdAt = new Date(Date.now() - 120_000);
    const expired = await db.workspaceInvitation.create({
      data: {
        workspaceId: scope.workspaceId,
        email: 'late@example.test',
        roleId: await roleId('viewer'),
        tokenHash: tokenHash(),
        createdAt,
        expiresAt: new Date(Date.now() - 60_000),
        invitedById: owner.id,
      },
    });
    expect(effectiveInvitationStatus(expired)).toBe('EXPIRED');
    expect(await repos.invitations.findUsableByTokenHash(expired.tokenHash)).toBeNull();
    expect(await repos.invitations.markAccepted(expired.id, owner.id)).toBe(false);
    expect(await repos.invitations.hasPending(scope, 'late@example.test')).toBe(false);

    // The partial unique index allows one PENDING row per email: expire first.
    await repos.invitations.expireStale(scope, 'late@example.test');
    await repos.invitations.create(scope, {
      email: 'late@example.test',
      roleId: await roleId('viewer'),
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: owner.id,
    });
    expect(await repos.invitations.countUsableForEmail('late@example.test')).toBe(1);
  });

  it('hides invitations of archived and deleted workspaces from invitees', async () => {
    const { scope, owner, roleId } = await newWorkspace('o@example.test', 'hidden');
    await repos.invitations.create(scope, {
      email: 'guest@example.test',
      roleId: await roleId('member'),
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: owner.id,
    });
    expect(await repos.invitations.listUsableForEmail('guest@example.test')).toHaveLength(1);
    await repos.workspaces.archive(scope);
    expect(await repos.invitations.listUsableForEmail('guest@example.test')).toHaveLength(0);
  });

  it('records the declined state with a timestamp', async () => {
    const { scope, owner, roleId } = await newWorkspace('o@example.test', 'decline');
    const invitation = await repos.invitations.create(scope, {
      email: 'no@example.test',
      roleId: await roleId('member'),
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: owner.id,
    });
    expect(await repos.invitations.markDeclined(invitation.id)).toBe(true);
    const row = await db.workspaceInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.status).toBe('DECLINED');
    expect(row.declinedAt).not.toBeNull();
  });
});
