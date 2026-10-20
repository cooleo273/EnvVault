import { randomUUID } from 'node:crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  activityPageSchema,
  environmentAccessSchema,
  environmentDetailSchema,
  environmentSummarySchema,
  environmentTemplateSchema,
  issuedInvitationSchema,
  paginatedSchema,
  projectAccessListSchema,
  projectDetailSchema,
  projectSummarySchema,
  workspaceMemberSchema,
  workspaceSummarySchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCode, Harness, type TestUser } from './support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await Harness.start();
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

async function ok<T>(
  promise: Promise<{ status: number; body: unknown }>,
  status: number,
  schema?: z.ZodType<T>,
) {
  const response = await promise;
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return (schema ? schema.parse(response.body) : response.body) as T;
}

async function newWorkspace(owner: TestUser, name = 'Acme') {
  return ok(call(owner, 'post', '/workspaces', { name }), 201, workspaceSummarySchema);
}

/** Invites and accepts; returns the workspace membership id. */
async function join(owner: TestUser, workspaceId: string, user: TestUser, roleKey = 'member') {
  const issued = await ok(
    call(owner, 'post', `/workspaces/${workspaceId}/invitations`, { email: user.email, roleKey }),
    201,
    issuedInvitationSchema,
  );
  const token = new URL(issued.acceptUrl ?? '').hash.replace('#token=', '');
  await ok(call(user, 'post', '/invitations/accept', { token }), 200);
  const members = await ok(
    call(owner, 'get', `/workspaces/${workspaceId}/members`),
    200,
    z.array(workspaceMemberSchema),
  );
  const found = members.find((m) => m.user.email === user.email);
  if (!found) throw new Error('join failed');
  return found.id;
}

const STANDARD_ENVS = [
  { name: 'Development', kind: 'DEVELOPMENT' },
  { name: 'QA', kind: 'TESTING' },
  { name: 'Production', kind: 'PRODUCTION', isProtected: true },
];

async function newProject(
  user: TestUser,
  ws: string,
  name = 'Backend',
  environments: object[] = STANDARD_ENVS,
) {
  return ok(
    call(user, 'post', `/workspaces/${ws}/projects`, { name, environments }),
    201,
    z.object({ id: z.uuid(), slug: z.string() }),
  );
}

async function envs(user: TestUser, ws: string, project: string, query = '') {
  return ok(
    call(user, 'get', `/workspaces/${ws}/projects/${project}/environments${query}`),
    200,
    paginatedSchema(environmentSummarySchema),
  );
}

async function envId(user: TestUser, ws: string, project: string, slug: string) {
  const list = await envs(user, ws, project, '?status=all');
  const found = list.items.find((e) => e.slug === slug);
  if (!found) throw new Error(`no env ${slug}`);
  return found.id;
}

async function stepUp(user: TestUser) {
  await ok(call(user, 'post', '/auth/step-up', { password: user.password }), 200);
}

async function audit(projectId: string) {
  return (
    await h.db.auditEvent.findMany({ where: { projectId }, orderBy: { occurredAt: 'asc' } })
  ).map((e) => e.action);
}

/** Owner, a workspace member with a project role, and the project ids. */
async function team(
  projectRole: 'project-developer' | 'project-viewer' | 'project-admin' | 'project-deployer',
) {
  const owner = h.newUser('owner');
  const dev = h.newUser('dev');
  const ws = await newWorkspace(owner);
  const devMembership = await join(owner, ws.id, dev);
  const project = await newProject(owner, ws.id);
  const base = `/workspaces/${ws.id}/projects/${project.id}`;
  await ok(
    call(owner, 'post', `${base}/members`, {
      workspaceMembershipId: devMembership,
      roleKey: projectRole,
    }),
    201,
  );
  return { owner, dev, ws, project, base, devMembership };
}

/* -------------------------------------------------------------------- tests */

describe('projects: CRUD, slugs, lifecycle', () => {
  it('creates projects with any number of environments and generated slugs', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const p1 = await newProject(owner, ws.id, 'E-Commerce Backend', [
      { name: 'Development', kind: 'DEVELOPMENT' },
      { name: 'QA', kind: 'TESTING' },
      { name: 'Staging', kind: 'STAGING' },
      { name: 'Production', kind: 'PRODUCTION', isProtected: true },
    ]);
    expect(p1.slug).toBe('e-commerce-backend');
    const p2 = await newProject(owner, ws.id, 'E-Commerce Backend', [
      { name: 'Local', kind: 'DEVELOPMENT' },
    ]);
    expect(p2.slug).toBe('e-commerce-backend-2');
    const empty = await newProject(owner, ws.id, 'Empty', []);

    const detail = await ok(
      call(owner, 'get', `/workspaces/${ws.id}/projects/${p1.id}`),
      200,
      projectDetailSchema,
    );
    expect(detail).toMatchObject({
      environmentCount: 4,
      protectedEnvironmentCount: 1,
      memberCount: 1,
      status: 'ACTIVE',
      access: { source: 'project_member', role: { key: 'project-admin', name: 'Project Admin' } },
    });
    // Workspace + project administration, but the owner's secret access is
    // only through the project role it got as creator.
    expect(detail.permissions).toContain('project:delete');
    expect((await envs(owner, ws.id, empty.id)).total).toBe(0);
    expect(await audit(p1.id)).toEqual(['project.created']);

    const explicit = await call(owner, 'post', `/workspaces/${ws.id}/projects`, {
      name: 'X',
      slug: 'empty',
    });
    expect([explicit.status, errorCode(explicit.body)]).toEqual([409, 'PROJECT_SLUG_TAKEN']);
    const dupNames = await call(owner, 'post', `/workspaces/${ws.id}/projects`, {
      name: 'Y',
      environments: [
        { name: 'QA', kind: 'TESTING' },
        { name: 'qa', kind: 'TESTING' },
      ],
    });
    expect([dupNames.status, errorCode(dupNames.body)]).toEqual([409, 'ENVIRONMENT_NAME_TAKEN']);
  });

  it('searches, filters, sorts, favorites and paginates', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const ids: Record<string, string> = {};
    for (const name of ['Mobile App', 'Internal Dashboard', 'Payments', 'Search', 'Billing']) {
      ids[name] = (await newProject(owner, ws.id, name, [])).id;
    }
    const list = (q: string) =>
      ok(
        call(owner, 'get', `/workspaces/${ws.id}/projects${q}`),
        200,
        paginatedSchema(projectSummarySchema),
      );
    const page = await list('?pageSize=2&page=2&sort=name');
    expect(page.items.map((p) => p.name)).toEqual(['Mobile App', 'Payments']);
    expect(page.total).toBe(5);
    expect((await list('?q=dash')).items.map((p) => p.name)).toEqual(['Internal Dashboard']);

    await ok(call(owner, 'put', `/workspaces/${ws.id}/projects/${ids.Search ?? ''}/favorite`), 204);
    expect((await list('?favorite=true')).items.map((p) => p.name)).toEqual(['Search']);
    await ok(call(owner, 'post', `/workspaces/${ws.id}/projects/${ids.Billing ?? ''}/visits`), 204);
    expect((await list('?sort=recent')).items.map((p) => p.name)).toEqual(['Billing']);

    await ok(
      call(owner, 'post', `/workspaces/${ws.id}/projects/${ids.Payments ?? ''}/archive`),
      204,
    );
    expect((await list('?status=archived')).items.map((p) => p.name)).toEqual(['Payments']);
    expect((await list('')).total).toBe(4);
    const bad = await call(owner, 'get', `/workspaces/${ws.id}/projects?pageSize=1000`);
    expect(bad.status).toBe(400);
  });

  it('archives read-only, restores, and deletes only with step-up', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const p = await newProject(owner, ws.id);
    const base = `/workspaces/${ws.id}/projects/${p.id}`;
    await ok(
      call(owner, 'patch', base, {
        name: 'Renamed',
        description: 'Core API',
        color: 'violet',
        icon: 'server',
      }),
      204,
    );
    await ok(call(owner, 'post', `${base}/archive`), 204);
    for (const response of [
      await call(owner, 'patch', base, { name: 'Nope' }),
      await call(owner, 'post', `${base}/environments`, { name: 'New' }),
      await call(owner, 'post', `${base}/archive`),
    ]) {
      expect([response.status, errorCode(response.body)]).toEqual([409, 'PROJECT_ARCHIVED']);
    }
    expect((await call(owner, 'get', base)).status).toBe(200);
    expect((await call(owner, 'get', `${base}/environments`)).status).toBe(200);
    await ok(call(owner, 'post', `${base}/restore`), 204);
    expect(errorCode((await call(owner, 'post', `${base}/restore`)).body)).toBe(
      'PROJECT_NOT_ARCHIVED',
    );

    const noStepUp = await call(owner, 'delete', base);
    expect(errorCode(noStepUp.body)).toBe('STEP_UP_REQUIRED');
    await stepUp(owner);
    await ok(call(owner, 'delete', base), 204);
    expect((await call(owner, 'get', base)).status).toBe(404);
    // Soft delete: environments and history are kept, not cascaded.
    expect(await h.db.environment.count({ where: { projectId: p.id } })).toBe(3);
    expect(await audit(p.id)).toEqual([
      'project.created',
      'project.updated',
      'project.archived',
      'project.restored',
      'project.deleted',
    ]);
  });

  it('duplicates metadata and environment structure, never members or grants', async () => {
    const { owner, ws, project, base, devMembership } = await team('project-developer');
    const prod = await envId(owner, ws.id, project.id, 'production');
    await ok(
      call(owner, 'post', `${base}/environments/${prod}/access`, {
        workspaceMembershipId: devMembership,
        roleKey: 'environment-reader',
      }),
      201,
    );
    const copy = await ok(
      call(owner, 'post', `${base}/duplicate`, { name: 'Backend Copy' }),
      201,
      z.object({ id: z.uuid(), slug: z.string() }),
    );
    const detail = await ok(
      call(owner, 'get', `/workspaces/${ws.id}/projects/${copy.id}`),
      200,
      projectDetailSchema,
    );
    expect(detail).toMatchObject({
      slug: 'backend-copy',
      environmentCount: 3,
      protectedEnvironmentCount: 1,
      memberCount: 1,
    });
    expect(await h.db.accessPolicy.count({ where: { projectId: copy.id } })).toBe(0);
    expect(await audit(copy.id)).toEqual(['project.duplicated']);
  });
});

describe('workspace isolation and default deny', () => {
  it('hides projects from workspace members without a project role', async () => {
    const owner = h.newUser('owner');
    const member = h.newUser('member');
    const viewer = h.newUser('viewer');
    const ws = await newWorkspace(owner);
    await join(owner, ws.id, member, 'member');
    await join(owner, ws.id, viewer, 'viewer');
    const p = await newProject(owner, ws.id);
    const base = `/workspaces/${ws.id}/projects/${p.id}`;

    const listed = await ok(
      call(member, 'get', `/workspaces/${ws.id}/projects`),
      200,
      paginatedSchema(projectSummarySchema),
    );
    expect(listed.total).toBe(0);
    for (const path of [base, `${base}/environments`, `${base}/members`, `${base}/activity`]) {
      expect((await call(member, 'get', path)).status, path).toBe(404);
    }
    // Members may create their own projects (and administer those); viewers may not.
    const own = await newProject(member, ws.id, 'Member Project', []);
    expect((await call(member, 'get', `/workspaces/${ws.id}/projects/${own.id}`)).status).toBe(200);
    expect(
      (await call(viewer, 'post', `/workspaces/${ws.id}/projects`, { name: 'No' })).status,
    ).toBe(403);
  });

  it('cannot reach projects, environments, members or grants through another parent', async () => {
    const alice = h.newUser('alice');
    const mallory = h.newUser('mallory');
    const aliceWs = await newWorkspace(alice, 'Alice');
    const malloryWs = await newWorkspace(mallory, 'Mallory');
    const aliceProject = await newProject(alice, aliceWs.id);
    const malloryProject = await newProject(mallory, malloryWs.id);
    const aliceEnv = await envId(alice, aliceWs.id, aliceProject.id, 'development');
    const aliceMembers = await ok(
      call(alice, 'get', `/workspaces/${aliceWs.id}/projects/${aliceProject.id}/members`),
      200,
      projectAccessListSchema,
    );
    const aliceMemberId = aliceMembers.members[0]?.id ?? '';

    const mBase = `/workspaces/${malloryWs.id}/projects/${malloryProject.id}`;
    const attempts = [
      // Alice's project through Mallory's workspace.
      call(mallory, 'get', `/workspaces/${malloryWs.id}/projects/${aliceProject.id}`),
      // Alice's environment through Mallory's project.
      call(mallory, 'get', `${mBase}/environments/${aliceEnv}`),
      call(mallory, 'patch', `${mBase}/environments/${aliceEnv}`, { name: 'Pwned' }),
      call(mallory, 'delete', `${mBase}/environments/${aliceEnv}`),
      call(mallory, 'post', `${mBase}/environments/${aliceEnv}/duplicate`, { name: 'Copy' }),
      call(mallory, 'patch', `${mBase}/members/${aliceMemberId}`, { roleKey: 'project-viewer' }),
      call(mallory, 'delete', `${mBase}/members/${aliceMemberId}`),
      // Alice's workspace directly.
      call(mallory, 'get', `/workspaces/${aliceWs.id}/projects`),
      call(mallory, 'get', `/workspaces/${aliceWs.id}/projects/${aliceProject.id}/environments`),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(404);
    // Mallory cannot reorder with Alice's ids either.
    const reorder = await call(mallory, 'put', `${mBase}/environments/order`, {
      environmentIds: [aliceEnv],
    });
    expect(reorder.status).toBe(404);
    expect((await h.db.environment.findUniqueOrThrow({ where: { id: aliceEnv } })).name).toBe(
      'Development',
    );
  });

  it('revokes project access when the workspace membership is removed', async () => {
    const { owner, dev, ws, base } = await team('project-developer');
    expect((await call(dev, 'get', base)).status).toBe(200);
    const members = await ok(
      call(owner, 'get', `/workspaces/${ws.id}/members`),
      200,
      z.array(workspaceMemberSchema),
    );
    const devWs = members.find((m) => m.user.email === dev.email)?.id ?? '';
    await ok(call(owner, 'delete', `/workspaces/${ws.id}/members/${devWs}`), 204);
    expect((await call(dev, 'get', base)).status).toBe(404);
    expect(await h.db.projectMembership.count({ where: { workspaceMembershipId: devWs } })).toBe(0);
  });

  it('requires authentication for every project endpoint', async () => {
    const id = randomUUID();
    const base = `/workspaces/${id}/projects/${id}`;
    for (const [method, path] of [
      ['get', `/workspaces/${id}/projects`],
      ['post', `/workspaces/${id}/projects`],
      ['get', base],
      ['get', `${base}/environments`],
      ['get', `${base}/environments/${id}`],
      ['get', `${base}/environments/${id}/access`],
      ['get', `${base}/members`],
      ['get', `${base}/activity`],
      ['get', `/workspaces/${id}/environment-templates`],
    ] as [Method, string][]) {
      expect((await h.api()[method](`/api/v1${path}`)).status, path).toBe(401);
    }
  });
});

describe('project roles', () => {
  it('lets developers read and work in unprotected environments only', async () => {
    const { dev, ws, project, base } = await team('project-developer');
    const detail = await ok(call(dev, 'get', base), 200, projectDetailSchema);
    expect(detail.access).toEqual({
      source: 'project_member',
      role: { key: 'project-developer', name: 'Developer' },
    });
    const devEnv = await ok(
      call(
        dev,
        'get',
        `${base}/environments/${await envId(dev, ws.id, project.id, 'development')}`,
      ),
      200,
      environmentDetailSchema,
    );
    expect(devEnv.permissions).toEqual(expect.arrayContaining(['secret:read', 'secret:write']));
    const prod = await ok(
      call(dev, 'get', `${base}/environments/${await envId(dev, ws.id, project.id, 'production')}`),
      200,
      environmentDetailSchema,
    );
    // No implicit production secret access.
    expect(prod.permissions.filter((p) => /^secret:(read|write|delete)/.test(p))).toEqual([]);

    for (const response of [
      await call(dev, 'patch', base, { name: 'Nope' }),
      await call(dev, 'post', `${base}/archive`),
      await call(dev, 'post', `${base}/environments`, { name: 'Mine' }),
      await call(dev, 'patch', `${base}/environments/${devEnv.id}`, { name: 'Nope' }),
      await call(dev, 'post', `${base}/members`, {
        workspaceMembershipId: randomUUID(),
        roleKey: 'project-admin',
      }),
      await call(dev, 'get', `${base}/environments/${devEnv.id}/access`),
    ]) {
      expect(response.status).toBe(403);
    }
  });

  it('gives deployment operators deploy rights outside protected environments only', async () => {
    const { dev, ws, project, base } = await team('project-deployer');
    const devEnv = await ok(
      call(
        dev,
        'get',
        `${base}/environments/${await envId(dev, ws.id, project.id, 'development')}`,
      ),
      200,
      environmentDetailSchema,
    );
    const prod = await ok(
      call(dev, 'get', `${base}/environments/${await envId(dev, ws.id, project.id, 'production')}`),
      200,
      environmentDetailSchema,
    );
    expect(devEnv.permissions).toContain('environment:deploy');
    expect(prod.permissions).not.toContain('environment:deploy');
    expect(devEnv.permissions).not.toContain('secret:read');
  });

  it('manages project members safely', async () => {
    const owner = h.newUser('owner');
    const admin = h.newUser('padmin');
    const outsider = h.newUser('outsider');
    const ws = await newWorkspace(owner);
    const otherWs = await newWorkspace(outsider, 'Other');
    const adminMembership = await join(owner, ws.id, admin);
    const p = await newProject(owner, ws.id);
    const base = `/workspaces/${ws.id}/projects/${p.id}`;
    const added = await ok(
      call(owner, 'post', `${base}/members`, {
        workspaceMembershipId: adminMembership,
        roleKey: 'project-admin',
      }),
      201,
      z.object({ id: z.uuid() }),
    );

    const outsiderMembership =
      (
        await ok(
          call(outsider, 'get', `/workspaces/${otherWs.id}/members`),
          200,
          z.array(workspaceMemberSchema),
        )
      )[0]?.id ?? '';
    const external = await call(owner, 'post', `${base}/members`, {
      workspaceMembershipId: outsiderMembership,
      roleKey: 'project-viewer',
    });
    expect([external.status, errorCode(external.body)]).toEqual([422, 'NOT_WORKSPACE_MEMBER']);
    const again = await call(owner, 'post', `${base}/members`, {
      workspaceMembershipId: adminMembership,
      roleKey: 'project-viewer',
    });
    expect(errorCode(again.body)).toBe('ALREADY_PROJECT_MEMBER');

    // The project admin cannot change their own role or remove themselves.
    const self = await call(admin, 'patch', `${base}/members/${added.id}`, {
      roleKey: 'project-viewer',
    });
    expect(errorCode(self.body)).toBe('CANNOT_CHANGE_OWN_ACCESS');

    const access = await ok(call(admin, 'get', `${base}/members`), 200, projectAccessListSchema);
    expect(access.members.map((m) => m.role.key).sort()).toEqual([
      'project-admin',
      'project-admin',
    ]);
    expect(access.inherited.map((i) => i.workspaceRole.key)).toEqual(['owner']);

    await ok(
      call(owner, 'patch', `${base}/members/${added.id}`, { roleKey: 'project-viewer' }),
      204,
    );
    expect((await call(admin, 'patch', base, { name: 'Nope' })).status).toBe(403);
    await ok(call(owner, 'delete', `${base}/members/${added.id}`), 204);
    expect((await call(admin, 'get', base)).status).toBe(404);
    expect(await audit(p.id)).toEqual(
      expect.arrayContaining([
        'project.member_added',
        'project.member_role_changed',
        'project.member_removed',
      ]),
    );
  });
});

describe('environments', () => {
  it('creates custom environments, renames without breaking ids, and rejects duplicate names', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const p = await newProject(owner, ws.id, 'Dashboard', []);
    const base = `/workspaces/${ws.id}/projects/${p.id}/environments`;
    for (const name of ['Local', 'Preview', 'Demo', 'Production']) {
      await ok(
        call(owner, 'post', base, {
          name,
          kind: name === 'Production' ? 'PRODUCTION' : 'OTHER',
          isProtected: name === 'Production',
        }),
        201,
      );
    }
    const qa = await ok(
      call(owner, 'post', base, {
        name: 'QA',
        kind: 'TESTING',
        expectedKeys: [{ key: 'API_URL' }],
      }),
      201,
      z.object({ id: z.uuid(), slug: z.string() }),
    );
    expect(qa.slug).toBe('qa');
    const duplicate = await call(owner, 'post', base, { name: 'qa' });
    expect([duplicate.status, errorCode(duplicate.body)]).toEqual([409, 'ENVIRONMENT_NAME_TAKEN']);

    await ok(call(owner, 'patch', `${base}/${qa.id}`, { name: 'Quality Assurance' }), 204);
    const renamed = await ok(call(owner, 'get', `${base}/${qa.id}`), 200, environmentDetailSchema);
    expect(renamed).toMatchObject({
      id: qa.id,
      slug: 'qa',
      name: 'Quality Assurance',
      expectedKeys: [{ key: 'API_URL' }],
    });
    // The old name is free again; slugs stay unique.
    const reused = await ok(
      call(owner, 'post', base, { name: 'QA' }),
      201,
      z.object({ id: z.uuid(), slug: z.string() }),
    );
    expect(reused.slug).toBe('qa-2');

    const all = await envs(owner, ws.id, p.id);
    expect(all.items.map((e) => e.name)).toEqual([
      'Local',
      'Preview',
      'Demo',
      'Production',
      'Quality Assurance',
      'QA',
    ]);
    const reversed = [...all.items].reverse().map((e) => e.id);
    await ok(call(owner, 'put', `${base}/order`, { environmentIds: reversed }), 204);
    expect((await envs(owner, ws.id, p.id)).items[0]?.name).toBe('QA');
    expect((await envs(owner, ws.id, p.id, '?kind=PRODUCTION')).items.map((e) => e.name)).toEqual([
      'Production',
    ]);
    expect((await envs(owner, ws.id, p.id, '?q=assur')).items.map((e) => e.name)).toEqual([
      'Quality Assurance',
    ]);
  });

  it('paginates large environment lists', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `Env ${String(i).padStart(2, '0')}`,
      kind: 'OTHER',
    }));
    const p = await newProject(owner, ws.id, 'Many', many);
    const page = await envs(owner, ws.id, p.id, '?pageSize=20&page=3');
    expect(page.total).toBe(50);
    expect(page.items.map((e) => e.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Env ${String(40 + i)}`),
    );
  });

  it('archives environments read-only and restores them', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const p = await newProject(owner, ws.id);
    const qa = await envId(owner, ws.id, p.id, 'qa');
    const base = `/workspaces/${ws.id}/projects/${p.id}/environments/${qa}`;
    await ok(call(owner, 'post', `${base}/archive`), 204);
    const blocked = await call(owner, 'patch', base, { name: 'X' });
    expect([blocked.status, errorCode(blocked.body)]).toEqual([409, 'ENVIRONMENT_ARCHIVED']);
    expect((await call(owner, 'get', base)).status).toBe(200);
    expect((await envs(owner, ws.id, p.id)).items.map((e) => e.slug)).toEqual([
      'development',
      'production',
    ]);
    expect((await envs(owner, ws.id, p.id, '?status=archived')).items.map((e) => e.slug)).toEqual([
      'qa',
    ]);
    await ok(call(owner, 'post', `${base}/restore`), 204);
    await ok(call(owner, 'post', `${base}/duplicate`, { name: 'QA 2' }), 201);
    expect(await audit(p.id)).toEqual(
      expect.arrayContaining([
        'environment.archived',
        'environment.restored',
        'environment.duplicated',
      ]),
    );
  });
});

describe('environment access grants and protection', () => {
  it('evaluates ALLOW and DENY grants per environment', async () => {
    const { owner, dev, ws, project, base, devMembership } = await team('project-developer');
    const qa = await envId(owner, ws.id, project.id, 'qa');
    const prod = await envId(owner, ws.id, project.id, 'production');
    // Developer may maintain QA metadata only.
    await ok(
      call(owner, 'post', `${base}/environments/${qa}/access`, {
        workspaceMembershipId: devMembership,
        roleKey: 'environment-maintainer',
      }),
      201,
    );
    await ok(call(dev, 'patch', `${base}/environments/${qa}`, { description: 'Owned by QA' }), 204);
    const devEnv = await envId(owner, ws.id, project.id, 'development');
    expect(
      (await call(dev, 'patch', `${base}/environments/${devEnv}`, { description: 'x' })).status,
    ).toBe(403);

    // A DENY grant hides production entirely.
    await ok(
      call(owner, 'post', `${base}/environments/${prod}/access`, {
        workspaceMembershipId: devMembership,
        roleKey: 'environment-viewer',
        effect: 'DENY',
      }),
      201,
    );
    expect((await call(dev, 'get', `${base}/environments/${prod}`)).status).toBe(404);
    expect((await envs(dev, ws.id, project.id)).items.map((e) => e.slug)).toEqual([
      'development',
      'qa',
    ]);

    const access = await ok(
      call(owner, 'get', `${base}/environments/${prod}/access`),
      200,
      environmentAccessSchema,
    );
    expect(access.grants.map((g) => [g.role.key, g.effect])).toEqual([
      ['environment-viewer', 'DENY'],
    ]);
    await ok(
      call(owner, 'delete', `${base}/environments/${prod}/access/${access.grants[0]?.id ?? ''}`),
      204,
    );
    expect((await call(dev, 'get', `${base}/environments/${prod}`)).status).toBe(200);
    expect(await audit(project.id)).toEqual(
      expect.arrayContaining(['environment.access_granted', 'environment.access_revoked']),
    );
  });

  it('grants production secret access only explicitly, and ignores expired grants', async () => {
    const { owner, dev, ws, project, base, devMembership } = await team('project-developer');
    const prod = await envId(owner, ws.id, project.id, 'production');
    const grant = await ok(
      call(owner, 'post', `${base}/environments/${prod}/access`, {
        workspaceMembershipId: devMembership,
        roleKey: 'environment-reader',
      }),
      201,
      z.object({ id: z.uuid() }),
    );
    let detail = await ok(
      call(dev, 'get', `${base}/environments/${prod}`),
      200,
      environmentDetailSchema,
    );
    expect(detail.permissions).toContain('secret:read');
    await h.db.accessPolicy.update({
      where: { id: grant.id },
      data: { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1000) },
    });
    detail = await ok(
      call(dev, 'get', `${base}/environments/${prod}`),
      200,
      environmentDetailSchema,
    );
    expect(detail.permissions).not.toContain('secret:read');
  });

  it('only grants to project members, never to yourself', async () => {
    const owner = h.newUser('owner');
    const stranger = h.newUser('stranger');
    const ws = await newWorkspace(owner);
    const strangerMembership = await join(owner, ws.id, stranger);
    const p = await newProject(owner, ws.id);
    const dev = await envId(owner, ws.id, p.id, 'development');
    const path = `/workspaces/${ws.id}/projects/${p.id}/environments/${dev}/access`;
    const notMember = await call(owner, 'post', path, {
      workspaceMembershipId: strangerMembership,
      roleKey: 'environment-viewer',
    });
    expect([notMember.status, errorCode(notMember.body)]).toEqual([422, 'NOT_PROJECT_MEMBER']);
    const ownerMembership =
      (
        await ok(
          call(owner, 'get', `/workspaces/${ws.id}/members`),
          200,
          z.array(workspaceMemberSchema),
        )
      ).find((m) => m.isCurrentUser)?.id ?? '';
    const self = await call(owner, 'post', path, {
      workspaceMembershipId: ownerMembership,
      roleKey: 'environment-writer',
    });
    expect(errorCode(self.body)).toBe('CANNOT_CHANGE_OWN_ACCESS');
  });

  it('requires environment:protect and step-up for protected-environment changes', async () => {
    const { owner, dev, ws, project, base, devMembership } = await team('project-developer');
    const prod = await envId(owner, ws.id, project.id, 'production');
    const prodBase = `${base}/environments/${prod}`;
    // A maintainer grant (environment:update) is not enough on production.
    await ok(
      call(owner, 'post', `${prodBase}/access`, {
        workspaceMembershipId: devMembership,
        roleKey: 'environment-maintainer',
      }),
      201,
    );
    for (const response of [
      await call(dev, 'patch', prodBase, { description: 'x' }),
      await call(dev, 'post', `${prodBase}/archive`),
    ]) {
      expect([response.status, errorCode(response.body)]).toEqual([403, 'PROTECTION_REQUIRED']);
    }
    expect((await call(dev, 'put', `${prodBase}/protection`, { isProtected: false })).status).toBe(
      403,
    );
    expect(
      (await call(dev, 'post', `${base}/environments`, { name: 'Prod 2', isProtected: true }))
        .status,
    ).toBe(403);

    // The owner can, but removing protection and deleting need step-up.
    await ok(call(owner, 'patch', prodBase, { description: 'Live' }), 204);
    await ok(
      call(owner, 'put', `${prodBase}/protection`, { isProtected: true, requiredApprovals: 2 }),
      204,
    );
    const unprotect = await call(owner, 'put', `${prodBase}/protection`, { isProtected: false });
    expect(errorCode(unprotect.body)).toBe('STEP_UP_REQUIRED');
    const del = await call(owner, 'delete', prodBase);
    expect(errorCode(del.body)).toBe('STEP_UP_REQUIRED');
    await stepUp(owner);
    await ok(call(owner, 'put', `${prodBase}/protection`, { isProtected: false }), 204);
    const after = await ok(call(owner, 'get', prodBase), 200, environmentDetailSchema);
    expect([after.isProtected, after.requiredApprovals]).toEqual([false, 0]);
    expect(await audit(project.id)).toEqual(
      expect.arrayContaining(['environment.protection_updated', 'environment.unprotected']),
    );
    const bad = await call(owner, 'put', `${prodBase}/protection`, {
      isProtected: false,
      requiredApprovals: 1,
    });
    expect(bad.status).toBe(400);
  });
});

describe('templates and activity', () => {
  it('lists built-in templates and manages workspace templates', async () => {
    const owner = h.newUser('owner');
    const member = h.newUser('member');
    const ws = await newWorkspace(owner);
    await join(owner, ws.id, member);
    const path = `/workspaces/${ws.id}/environment-templates`;
    const before = await ok(call(member, 'get', path), 200, z.array(environmentTemplateSchema));
    expect(before.map((t) => t.name)).toEqual([
      'Development',
      'QA',
      'Testing',
      'Staging',
      'UAT',
      'Production',
      'Demo',
      'Preview',
    ]);
    expect(before.find((t) => t.name === 'Production')?.environments[0]?.isProtected).toBe(true);

    const body = {
      name: 'Web stack',
      environments: [
        { name: 'Local', kind: 'DEVELOPMENT', expectedKeys: [{ key: 'PORT' }] },
        { name: 'Live', kind: 'PRODUCTION', isProtected: true },
      ],
    };
    expect((await call(member, 'post', path, body)).status).toBe(403);
    const created = await ok(call(owner, 'post', path, body), 201, environmentTemplateSchema);
    const dup = await call(owner, 'post', path, body);
    expect(errorCode(dup.body)).toBe('TEMPLATE_NAME_TAKEN');
    expect(
      (await ok(call(member, 'get', path), 200, z.array(environmentTemplateSchema))).at(-1)?.name,
    ).toBe('Web stack');
    await ok(call(owner, 'delete', `${path}/${created.id}`), 204);
  });

  it('pages project activity without exposing other projects', async () => {
    const owner = h.newUser('owner');
    const ws = await newWorkspace(owner);
    const p = await newProject(owner, ws.id);
    const other = await newProject(owner, ws.id, 'Other');
    const base = `/workspaces/${ws.id}/projects/${p.id}`;
    for (const name of ['A', 'B', 'C']) await ok(call(owner, 'patch', base, { name }), 204);
    const first = await ok(call(owner, 'get', `${base}/activity?limit=2`), 200, activityPageSchema);
    expect(first.items.map((e) => e.action)).toEqual(['project.updated', 'project.updated']);
    expect(first.items[0]?.actor?.email).toBe(owner.email);
    const second = await ok(
      call(owner, 'get', `${base}/activity?limit=2&cursor=${first.nextCursor ?? ''}`),
      200,
      activityPageSchema,
    );
    expect(second.items.map((e) => e.action)).toEqual(['project.updated', 'project.created']);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(all.some((e) => e.resourceId === other.id)).toBe(false);
    expect((await call(owner, 'get', `${base}/activity?cursor=bogus`)).status).toBe(400);
  });
});
