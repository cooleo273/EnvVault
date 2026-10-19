import { createHash, randomUUID } from 'node:crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  issuedInvitationSchema,
  meResponseSchema,
  receivedInvitationSchema,
  workspaceDetailSchema,
  workspaceInvitationSchema,
  workspaceMemberSchema,
  workspaceSummarySchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCode, Harness, type TestUser } from './support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await Harness.start({ APP_BASE_URL: 'http://localhost:3000' });
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await truncateAllTables(h.db);
});

/* ------------------------------------------------------------------ helpers */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

async function call(user: TestUser, method: Method, path: string, body?: object) {
  const req = h
    .api()
    [method](`/api/v1${path}`)
    .set('Authorization', await h.bearer(user));
  return body === undefined ? req : req.send(body);
}

async function createWorkspace(
  user: TestUser,
  body: { name: string; slug?: string; type?: 'PERSONAL' | 'TEAM'; description?: string },
) {
  const response = await call(user, 'post', '/workspaces', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return workspaceSummarySchema.parse(response.body);
}

async function invite(owner: TestUser, workspaceId: string, email: string, roleKey = 'member') {
  const response = await call(owner, 'post', `/workspaces/${workspaceId}/invitations`, {
    email,
    roleKey,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return issuedInvitationSchema.parse(response.body);
}

function tokenOf(acceptUrl: string | null): string {
  const token = new URL(acceptUrl ?? '').hash.replace('#token=', '');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
}

/** Invites `user` with `roleKey` and accepts; returns their membership id. */
async function addMember(owner: TestUser, workspaceId: string, user: TestUser, roleKey: string) {
  const issued = await invite(owner, workspaceId, user.email, roleKey);
  await call(user, 'post', '/invitations/accept', { token: tokenOf(issued.acceptUrl) }).then(
    (r) => {
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    },
  );
  return membershipOf(owner, workspaceId, user);
}

async function members(user: TestUser, workspaceId: string) {
  const response = await call(user, 'get', `/workspaces/${workspaceId}/members`);
  expect(response.status).toBe(200);
  return z.array(workspaceMemberSchema).parse(response.body);
}

async function membershipOf(viewer: TestUser, workspaceId: string, user: TestUser) {
  const found = (await members(viewer, workspaceId)).find((m) => m.user.email === user.email);
  if (!found) throw new Error(`${user.email} is not a member`);
  return found;
}

async function stepUp(user: TestUser) {
  const response = await call(user, 'post', '/auth/step-up', { password: user.password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function me(user: TestUser) {
  const response = await call(user, 'get', '/users/me');
  expect(response.status).toBe(200);
  return meResponseSchema.parse(response.body);
}

async function auditActions(workspaceId: string) {
  const rows = await h.db.auditEvent.findMany({
    where: { workspaceId },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, metadata: true },
  });
  return rows;
}

/* -------------------------------------------------------------------- tests */

describe('GET /users/me and workspace selection', () => {
  it('drives onboarding: none, one, remembered, and fallback after access is revoked', async () => {
    const alice = h.newUser('alice');
    const bob = h.newUser('bob');
    expect(await me(alice)).toMatchObject({ workspaces: [], activeWorkspaceId: null });

    const first = await createWorkspace(alice, { name: 'First' });
    expect((await me(alice)).activeWorkspaceId).toBe(first.id);

    const bobs = await createWorkspace(bob, { name: 'Bob Team' });
    await addMember(bob, bobs.id, alice, 'member');
    // Accepting an invitation selects that workspace.
    expect((await me(alice)).activeWorkspaceId).toBe(bobs.id);

    await call(alice, 'put', '/users/me/active-workspace', { workspaceId: first.id }).then((r) => {
      expect(r.status).toBe(204);
    });
    expect((await me(alice)).activeWorkspaceId).toBe(first.id);
    await call(alice, 'put', '/users/me/active-workspace', { workspaceId: bobs.id });

    // Bob removes Alice: her remembered selection is no longer honoured.
    const aliceInBobs = await membershipOf(bob, bobs.id, alice);
    await call(bob, 'delete', `/workspaces/${bobs.id}/members/${aliceInBobs.id}`).then((r) => {
      expect(r.status).toBe(204);
    });
    const after = await me(alice);
    expect(after.activeWorkspaceId).toBe(first.id);
    expect(after.workspaces.map((w) => w.id)).toEqual([first.id]);
  });

  it('refuses to select a workspace the caller does not belong to', async () => {
    const alice = h.newUser('alice');
    const mallory = h.newUser('mallory');
    const ws = await createWorkspace(alice, { name: 'Private' });
    for (const workspaceId of [ws.id, randomUUID()]) {
      const response = await call(mallory, 'put', '/users/me/active-workspace', { workspaceId });
      expect(response.status).toBe(404);
    }
  });
});

describe('workspace creation and updates', () => {
  it('generates slugs, stores type and description, and records an audit event', async () => {
    const alice = h.newUser('alice');
    const ws = await createWorkspace(alice, {
      name: 'Acme Corp',
      type: 'PERSONAL',
      description: 'Our secrets',
    });
    expect(ws).toMatchObject({
      slug: 'acme-corp',
      type: 'PERSONAL',
      description: 'Our secrets',
      archivedAt: null,
      role: { key: 'owner', name: 'Owner' },
    });
    // Same name again: the generated slug gets a random suffix.
    const again = await createWorkspace(alice, { name: 'Acme Corp' });
    expect(again.slug).toMatch(/^acme-corp-[0-9a-f]{6}$/);
    expect((await auditActions(ws.id)).map((e) => e.action)).toEqual(['workspace.created']);
  });

  it('rejects a duplicate explicit slug with 409 SLUG_TAKEN and invalid input with 400', async () => {
    const alice = h.newUser('alice');
    await createWorkspace(alice, { name: 'One', slug: 'taken' });
    const duplicate = await call(alice, 'post', '/workspaces', { name: 'Two', slug: 'taken' });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('SLUG_TAKEN');

    for (const body of [
      { name: '' },
      { name: 'x', slug: 'Bad Slug' },
      { name: 'x', type: 'ORG' },
    ]) {
      const response = await call(alice, 'post', '/workspaces', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('lets owners and admins update settings, but not members or viewers', async () => {
    const owner = h.newUser('owner');
    const admin = h.newUser('admin');
    const member = h.newUser('member');
    const viewer = h.newUser('viewer');
    const ws = await createWorkspace(owner, { name: 'Settings' });
    await addMember(owner, ws.id, admin, 'admin');
    await addMember(owner, ws.id, member, 'member');
    await addMember(owner, ws.id, viewer, 'viewer');

    for (const [user, name] of [
      [owner, 'By owner'],
      [admin, 'By admin'],
    ] as const) {
      const response = await call(user, 'patch', `/workspaces/${ws.id}`, { name });
      expect(response.status).toBe(204);
    }
    for (const user of [member, viewer]) {
      const response = await call(user, 'patch', `/workspaces/${ws.id}`, { name: 'Nope' });
      expect(response.status).toBe(403);
    }
    await call(admin, 'patch', `/workspaces/${ws.id}`, { description: 'Payments' });
    const detail = workspaceDetailSchema.parse(
      (await call(viewer, 'get', `/workspaces/${ws.id}`)).body,
    );
    expect(detail).toMatchObject({ name: 'By admin', description: 'Payments', memberCount: 4 });
    expect(detail.role.key).toBe('viewer');
    // Workspace roles never carry secret permissions.
    expect(detail.permissions.some((p) => p.startsWith('secret:'))).toBe(false);
    expect(
      (await auditActions(ws.id)).filter((e) => e.action === 'workspace.updated'),
    ).toHaveLength(3);
  });
});

describe('archive and restore', () => {
  it('makes the workspace read-only until an owner restores it', async () => {
    const owner = h.newUser('owner');
    const admin = h.newUser('admin');
    const ws = await createWorkspace(owner, { name: 'Archive me' });
    await addMember(owner, ws.id, admin, 'admin');

    expect((await call(admin, 'post', `/workspaces/${ws.id}/archive`)).status).toBe(403);
    expect((await call(owner, 'post', `/workspaces/${ws.id}/archive`)).status).toBe(204);

    const blocked = [
      await call(owner, 'patch', `/workspaces/${ws.id}`, { name: 'Changed' }),
      await call(owner, 'post', `/workspaces/${ws.id}/invitations`, {
        email: 'new@example.test',
        roleKey: 'member',
      }),
      await call(owner, 'post', `/workspaces/${ws.id}/archive`),
    ];
    for (const response of blocked) {
      expect(response.status).toBe(409);
      expect(errorCode(response.body)).toBe('WORKSPACE_ARCHIVED');
    }
    // Still readable; hidden from the default list.
    expect((await call(admin, 'get', `/workspaces/${ws.id}`)).status).toBe(200);
    expect((await call(owner, 'get', '/workspaces')).body).toEqual([]);
    const all = await call(owner, 'get', '/workspaces?archived=include');
    expect(z.array(workspaceSummarySchema).parse(all.body)[0]?.archivedAt).not.toBeNull();
    expect((await me(owner)).activeWorkspaceId).toBeNull();

    expect((await call(admin, 'post', `/workspaces/${ws.id}/restore`)).status).toBe(403);
    expect((await call(owner, 'post', `/workspaces/${ws.id}/restore`)).status).toBe(204);
    const again = await call(owner, 'post', `/workspaces/${ws.id}/restore`);
    expect(errorCode(again.body)).toBe('WORKSPACE_NOT_ARCHIVED');
    expect((await call(owner, 'patch', `/workspaces/${ws.id}`, { name: 'Back' })).status).toBe(204);
    expect((await auditActions(ws.id)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['workspace.archived', 'workspace.restored']),
    );
  });
});

describe('invitations', () => {
  it('issues a single-use, hashed token and reports that email is not configured', async () => {
    const owner = h.newUser('owner');
    const guest = h.newUser('guest');
    const ws = await createWorkspace(owner, { name: 'Invites' });
    const issued = await invite(owner, ws.id, guest.email.toUpperCase(), 'viewer');
    expect(issued.delivery.status).toBe('not_configured');
    expect(issued.invitation).toMatchObject({ email: guest.email, status: 'PENDING' });
    const token = tokenOf(issued.acceptUrl);
    expect(issued.acceptUrl).toBe(`http://localhost:3000/invite#token=${token}`);

    // Only the SHA-256 of the token is stored; it never appears in audit logs.
    const row = await h.db.workspaceInvitation.findUniqueOrThrow({
      where: { id: issued.invitation.id },
    });
    expect(Buffer.from(row.tokenHash).equals(createHash('sha256').update(token).digest())).toBe(
      true,
    );
    const audit = JSON.stringify(await h.db.auditEvent.findMany());
    expect(audit).not.toContain(token);

    const preview = await call(guest, 'post', '/invitations/lookup', { token });
    expect(receivedInvitationSchema.parse(preview.body)).toMatchObject({
      workspace: { name: 'Invites' },
      role: { key: 'viewer' },
    });
    const accepted = await call(guest, 'post', '/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ workspaceId: ws.id });
    expect((await membershipOf(owner, ws.id, guest)).role.key).toBe('viewer');

    // Replay: the same link cannot be used again, by anyone.
    for (const path of ['/invitations/accept', '/invitations/lookup', '/invitations/decline']) {
      const replay = await call(guest, 'post', path, { token });
      expect(replay.status, path).toBe(404);
      expect(errorCode(replay.body)).toBe('INVITATION_INVALID');
    }
    expect((await auditActions(ws.id)).map((e) => e.action)).toEqual([
      'workspace.created',
      'member.invited',
      'invitation.accepted',
    ]);
  });

  it('only lets the invited email address use an invitation', async () => {
    const owner = h.newUser('owner');
    const guest = h.newUser('guest');
    const other = h.newUser('other');
    const unverified = h.newUser('unverified', { emailVerified: false });
    const ws = await createWorkspace(owner, { name: 'Bound' });
    const token = tokenOf((await invite(owner, ws.id, guest.email)).acceptUrl);

    for (const path of ['/invitations/lookup', '/invitations/accept']) {
      const response = await call(other, 'post', path, { token });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INVITATION_EMAIL_MISMATCH');
    }
    expect((await call(unverified, 'post', '/invitations/accept', { token })).status).toBe(403);
    expect((await call(other, 'get', '/invitations')).body).toEqual([]);
    // Still usable by the right person.
    expect((await call(guest, 'post', '/invitations/accept', { token })).status).toBe(200);
  });

  it('rejects expired, revoked and resent (superseded) links', async () => {
    const owner = h.newUser('owner');
    const late = h.newUser('late');
    const revoked = h.newUser('revoked');
    const resent = h.newUser('resent');
    const ws = await createWorkspace(owner, { name: 'Lifecycle' });

    const lateInvite = await invite(owner, ws.id, late.email);
    await h.db.workspaceInvitation.update({
      where: { id: lateInvite.invitation.id },
      data: { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await call(late, 'post', '/invitations/accept', {
      token: tokenOf(lateInvite.acceptUrl),
    });
    expect(errorCode(expired.body)).toBe('INVITATION_INVALID');
    const listed = z
      .array(workspaceInvitationSchema)
      .parse((await call(owner, 'get', `/workspaces/${ws.id}/invitations`)).body);
    expect(listed.find((i) => i.id === lateInvite.invitation.id)?.status).toBe('EXPIRED');
    // An expired invitation does not block a new one, and can be resent.
    const renewed = await call(
      owner,
      'post',
      `/workspaces/${ws.id}/invitations/${lateInvite.invitation.id}/resend`,
    );
    expect(renewed.status).toBe(201);
    const renewedToken = tokenOf(issuedInvitationSchema.parse(renewed.body).acceptUrl);
    expect((await call(late, 'post', '/invitations/accept', { token: renewedToken })).status).toBe(
      200,
    );

    const revokedInvite = await invite(owner, ws.id, revoked.email);
    expect(
      (
        await call(
          owner,
          'delete',
          `/workspaces/${ws.id}/invitations/${revokedInvite.invitation.id}`,
        )
      ).status,
    ).toBe(204);
    const afterRevoke = await call(revoked, 'post', '/invitations/accept', {
      token: tokenOf(revokedInvite.acceptUrl),
    });
    expect(errorCode(afterRevoke.body)).toBe('INVITATION_INVALID');

    const first = await invite(owner, ws.id, resent.email);
    const second = issuedInvitationSchema.parse(
      (await call(owner, 'post', `/workspaces/${ws.id}/invitations/${first.invitation.id}/resend`))
        .body,
    );
    expect(second.invitation.id).not.toBe(first.invitation.id);
    const stale = await call(resent, 'post', '/invitations/accept', {
      token: tokenOf(first.acceptUrl),
    });
    expect(errorCode(stale.body)).toBe('INVITATION_INVALID');
    expect(
      (await call(resent, 'post', '/invitations/accept', { token: tokenOf(second.acceptUrl) }))
        .status,
    ).toBe(200);

    const actions = (await auditActions(ws.id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.revoked', 'invitation.resent']));
  });

  it('supports in-app acceptance and declining by id for the invitee only', async () => {
    const owner = h.newUser('owner');
    const guest = h.newUser('guest');
    const other = h.newUser('other');
    const ws = await createWorkspace(owner, { name: 'In app' });
    const second = await createWorkspace(owner, { name: 'Second' });
    const one = await invite(owner, ws.id, guest.email);
    const two = await invite(owner, second.id, guest.email);

    expect((await me(guest)).pendingInvitationCount).toBe(2);
    expect((await call(other, 'post', `/invitations/${one.invitation.id}/accept`)).status).toBe(
      404,
    );
    expect((await call(guest, 'post', `/invitations/${one.invitation.id}/accept`)).status).toBe(
      200,
    );
    expect((await call(guest, 'post', `/invitations/${two.invitation.id}/decline`)).status).toBe(
      204,
    );
    expect((await call(guest, 'post', `/invitations/${two.invitation.id}/accept`)).status).toBe(
      404,
    );
    expect((await me(guest)).workspaces.map((w) => w.id)).toEqual([ws.id]);
    const row = await h.db.workspaceInvitation.findUniqueOrThrow({
      where: { id: two.invitation.id },
    });
    expect(row.status).toBe('DECLINED');
  });

  it('rejects duplicates, existing members, owner invitations and non-admins', async () => {
    const owner = h.newUser('owner');
    const member = h.newUser('member');
    const ws = await createWorkspace(owner, { name: 'Rules' });
    await addMember(owner, ws.id, member, 'member');

    await invite(owner, ws.id, 'pending@example.test');
    const duplicate = await call(owner, 'post', `/workspaces/${ws.id}/invitations`, {
      email: 'pending@example.test',
      roleKey: 'viewer',
    });
    expect(errorCode(duplicate.body)).toBe('INVITATION_PENDING');

    const existing = await call(owner, 'post', `/workspaces/${ws.id}/invitations`, {
      email: member.email,
      roleKey: 'viewer',
    });
    expect(errorCode(existing.body)).toBe('ALREADY_MEMBER');

    const asOwner = await call(owner, 'post', `/workspaces/${ws.id}/invitations`, {
      email: 'boss@example.test',
      roleKey: 'owner',
    });
    expect(asOwner.status).toBe(400);

    const byMember = await call(member, 'post', `/workspaces/${ws.id}/invitations`, {
      email: 'x@example.test',
      roleKey: 'member',
    });
    expect(byMember.status).toBe(403);
    expect((await call(member, 'get', `/workspaces/${ws.id}/invitations`)).status).toBe(403);
  });
});

describe('roles, removal and the final owner', () => {
  it('enforces who may assign which roles', async () => {
    const owner = h.newUser('owner');
    const admin = h.newUser('admin');
    const member = h.newUser('member');
    const ws = await createWorkspace(owner, { name: 'RBAC' });
    const adminM = await addMember(owner, ws.id, admin, 'admin');
    const memberM = await addMember(owner, ws.id, member, 'member');
    const ownerM = await membershipOf(owner, ws.id, owner);
    const patch = (actor: TestUser, membershipId: string, roleKey: string) =>
      call(actor, 'patch', `/workspaces/${ws.id}/members/${membershipId}`, { roleKey });

    // Admins manage non-owners but cannot create or touch owners.
    expect((await patch(admin, memberM.id, 'viewer')).status).toBe(204);
    const promote = await patch(admin, memberM.id, 'owner');
    expect([promote.status, errorCode(promote.body)]).toEqual([403, 'OWNER_REQUIRED']);
    expect(errorCode((await patch(admin, ownerM.id, 'member')).body)).toBe('OWNER_REQUIRED');
    // Members cannot administer at all; nobody changes their own role.
    expect((await patch(member, adminM.id, 'viewer')).status).toBe(403);
    expect(errorCode((await patch(admin, adminM.id, 'member')).body)).toBe(
      'CANNOT_CHANGE_OWN_ROLE',
    );
    expect(errorCode((await patch(owner, ownerM.id, 'admin')).body)).toBe('CANNOT_CHANGE_OWN_ROLE');

    expect((await patch(owner, memberM.id, 'admin')).status).toBe(204);
    expect((await membershipOf(owner, ws.id, member)).role.key).toBe('admin');
    const roleEvents = (await auditActions(ws.id)).filter(
      (e) => e.action === 'member.role_changed',
    );
    expect(roleEvents.map((e) => e.metadata)).toEqual([
      { from: 'member', to: 'viewer' },
      { from: 'viewer', to: 'admin' },
    ]);
  });

  it('never removes or demotes the final owner', async () => {
    const owner = h.newUser('owner');
    const second = h.newUser('second');
    const admin = h.newUser('admin');
    const ws = await createWorkspace(owner, { name: 'Owners' });
    const adminM = await addMember(owner, ws.id, admin, 'admin');
    const ownerM = await membershipOf(owner, ws.id, owner);

    const leave = await call(owner, 'post', `/workspaces/${ws.id}/leave`);
    expect([leave.status, errorCode(leave.body)]).toEqual([409, 'LAST_OWNER']);
    const byAdmin = await call(admin, 'delete', `/workspaces/${ws.id}/members/${ownerM.id}`);
    expect(errorCode(byAdmin.body)).toBe('OWNER_REQUIRED');

    // With a co-owner, owners can demote each other, but never the last one.
    const secondM = await addMember(owner, ws.id, second, 'admin');
    await call(owner, 'patch', `/workspaces/${ws.id}/members/${secondM.id}`, { roleKey: 'owner' });
    expect(
      (
        await call(second, 'patch', `/workspaces/${ws.id}/members/${ownerM.id}`, {
          roleKey: 'admin',
        })
      ).status,
    ).toBe(204);
    const lastDemote = await call(owner, 'patch', `/workspaces/${ws.id}/members/${secondM.id}`, {
      roleKey: 'member',
    });
    expect(lastDemote.status).toBe(403); // owner is now an admin
    expect(errorCode((await call(second, 'post', `/workspaces/${ws.id}/leave`)).body)).toBe(
      'LAST_OWNER',
    );

    // Admins and members can leave; admins can remove members.
    expect((await call(admin, 'post', `/workspaces/${ws.id}/leave`)).status).toBe(204);
    expect((await call(second, 'delete', `/workspaces/${ws.id}/members/${adminM.id}`)).status).toBe(
      404,
    );
    expect(await h.db.workspaceMembership.count({ where: { workspaceId: ws.id } })).toBe(2);
    expect((await auditActions(ws.id)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['member.left']),
    );
  });

  it('transfers ownership only after step-up, making the old owner an admin', async () => {
    const owner = h.newUser('owner');
    const admin = h.newUser('admin');
    const outsider = h.newUser('outsider');
    const ws = await createWorkspace(owner, { name: 'Transfer' });
    const other = await createWorkspace(outsider, { name: 'Elsewhere' });
    const adminM = await addMember(owner, ws.id, admin, 'admin');
    const outsiderM = await membershipOf(outsider, other.id, outsider);

    const path = `/workspaces/${ws.id}/transfer-ownership`;
    const noStepUp = await call(owner, 'post', path, { membershipId: adminM.id });
    expect([noStepUp.status, errorCode(noStepUp.body)]).toEqual([403, 'STEP_UP_REQUIRED']);
    await stepUp(admin);
    expect((await call(admin, 'post', path, { membershipId: adminM.id })).status).toBe(403);

    await stepUp(owner);
    // A membership of another workspace cannot be targeted through this one.
    expect((await call(owner, 'post', path, { membershipId: outsiderM.id })).status).toBe(404);
    expect((await call(owner, 'post', path, { membershipId: adminM.id })).status).toBe(204);

    const roles = Object.fromEntries(
      (await members(owner, ws.id)).map((m) => [m.user.email, m.role.key]),
    );
    expect(roles).toEqual({ [admin.email]: 'owner', [owner.email]: 'admin' });
    expect((await auditActions(ws.id)).map((e) => e.action)).toContain(
      'workspace.ownership_transferred',
    );
  });
});

describe('cross-workspace access', () => {
  it('cannot reach another workspace through ids from it', async () => {
    const alice = h.newUser('alice');
    const bob = h.newUser('bob');
    const aliceWs = await createWorkspace(alice, { name: 'Alice' });
    const bobWs = await createWorkspace(bob, { name: 'Bob' });
    const bobOwner = await membershipOf(bob, bobWs.id, bob);
    const bobInvite = await invite(bob, bobWs.id, 'someone@example.test');

    // Alice's workspace path with Bob's resource ids: nothing is found.
    const viaOwnWorkspace = [
      await call(alice, 'patch', `/workspaces/${aliceWs.id}/members/${bobOwner.id}`, {
        roleKey: 'viewer',
      }),
      await call(alice, 'delete', `/workspaces/${aliceWs.id}/members/${bobOwner.id}`),
      await call(
        alice,
        'delete',
        `/workspaces/${aliceWs.id}/invitations/${bobInvite.invitation.id}`,
      ),
      await call(
        alice,
        'post',
        `/workspaces/${aliceWs.id}/invitations/${bobInvite.invitation.id}/resend`,
      ),
    ];
    for (const response of viaOwnWorkspace) expect(response.status).toBe(404);

    // Bob's workspace directly: 404 for every route (no existence oracle).
    const direct = [
      await call(alice, 'get', `/workspaces/${bobWs.id}`),
      await call(alice, 'get', `/workspaces/${bobWs.id}/members`),
      await call(alice, 'get', `/workspaces/${bobWs.id}/roles`),
      await call(alice, 'get', `/workspaces/${bobWs.id}/invitations`),
      await call(alice, 'patch', `/workspaces/${bobWs.id}`, { name: 'Owned' }),
      await call(alice, 'post', `/workspaces/${bobWs.id}/archive`),
      await call(alice, 'post', `/workspaces/${bobWs.id}/leave`),
    ];
    for (const response of direct) expect(response.status).toBe(404);
    expect(await h.db.workspaceMembership.count({ where: { workspaceId: bobWs.id } })).toBe(1);
  });

  it('requires authentication for every new endpoint', async () => {
    const id = randomUUID();
    const routes: [Method, string][] = [
      ['get', '/users/me'],
      ['put', '/users/me/active-workspace'],
      ['get', '/workspaces'],
      ['patch', `/workspaces/${id}`],
      ['post', `/workspaces/${id}/archive`],
      ['post', `/workspaces/${id}/restore`],
      ['get', `/workspaces/${id}/members`],
      ['get', `/workspaces/${id}/invitations`],
      ['get', '/invitations'],
      ['post', '/invitations/accept'],
      ['post', '/auth/tokens/revoke'],
    ];
    for (const [method, path] of routes) {
      const response = await h.api()[method](`/api/v1${path}`);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('token revocation after account changes', () => {
  it('rejects tokens issued before a password change', async () => {
    const alice = h.newUser('alice');
    const old = await alice.token();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await call(alice, 'post', '/auth/tokens/revoke', {
      reason: 'password_changed',
    });
    expect(response.status).toBe(204);
    const stale = await h.api().get('/api/v1/users/me').set('Authorization', `Bearer ${old}`);
    expect(errorCode(stale.body)).toBe('TOKEN_REVOKED');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await call(alice, 'get', '/users/me')).status).toBe(200);
    const row = await h.db.authTokenRevocation.findFirstOrThrow();
    expect(row.reason).toBe('PASSWORD_CHANGED');
  });
});

describe('rate limiting of invitation tokens', () => {
  it('throttles token guessing per client', async () => {
    const strict = await Harness.start({ RATE_LIMIT_SENSITIVE_MAX: '3' });
    try {
      const user = strict.newUser('guesser');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await strict
          .api()
          .post('/api/v1/invitations/lookup')
          .set('Authorization', await strict.bearer(user))
          .send({ token: 'A'.repeat(43) });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([404, 404, 404, 429]);
    } finally {
      await strict.stop();
    }
  });
});
