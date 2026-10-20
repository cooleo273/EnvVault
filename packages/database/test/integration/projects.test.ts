import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getConstraintViolation } from '../../src/errors.js';
import { createRepositories } from '../../src/repositories/index.js';
import {
  createAuthorizedEnvironmentScope,
  createAuthorizedProjectScope,
  createAuthorizedWorkspaceScope,
} from '../../src/scope.js';
import { withTransaction } from '../../src/transaction.js';
import { disconnectTestDb, testDb, truncateAll, userData } from './helpers.js';

const db = testDb();
const repos = createRepositories(db);

async function setup(label: string) {
  const owner = await db.user.create({ data: userData(`${label}-owner@example.test`) });
  const ws = await withTransaction(db, (tx) =>
    createRepositories(tx).workspaces.createWithOwner({
      name: label,
      slug: label,
      ownerUserId: owner.id,
    }),
  );
  const scope = createAuthorizedWorkspaceScope(ws.id);
  const membership = await repos.memberships.findActiveMembership(ws.id, owner.id);
  if (!membership) throw new Error('membership missing');
  const viewer = {
    userId: owner.id,
    workspaceMembershipId: membership.membershipId,
    seesAllProjects: true,
  };
  return { owner, ws, scope, membershipId: membership.membershipId, viewer };
}

function env(name: string, sortOrder: number, isProtected = false) {
  return {
    name,
    slug: name.toLowerCase(),
    kind: isProtected ? ('PRODUCTION' as const) : ('DEVELOPMENT' as const),
    color: 'green',
    isProtected,
    expectedKeys: [{ key: 'DATABASE_URL' }],
    sortOrder,
  };
}

async function createProject(
  ctx: Awaited<ReturnType<typeof setup>>,
  name: string,
  environments = [env('Development', 0), env('Production', 10, true)],
) {
  return withTransaction(db, (tx) =>
    createRepositories(tx).projects.create(ctx.scope, {
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      icon: 'folder',
      color: 'blue',
      createdById: ctx.owner.id,
      adminWorkspaceMembershipId: ctx.membershipId,
      environments,
    }),
  );
}

async function rejection(operation: Promise<unknown>) {
  return operation.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
}

describe('projects', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(disconnectTestDb);

  it('creates a project with its creator as Project Admin and any number of environments', async () => {
    const ctx = await setup('acme');
    const project = await createProject(ctx, 'Backend', [
      env('Local', 0),
      env('Development', 10),
      env('QA', 20),
      env('Staging', 30),
      env('Production', 40, true),
    ]);
    const pScope = createAuthorizedProjectScope(ctx.ws.id, project.id);
    const detail = await repos.projects.getDetail(pScope, ctx.viewer);
    expect(detail).toMatchObject({
      environmentCount: 5,
      protectedEnvironmentCount: 1,
      memberCount: 1,
      role: { key: 'project-admin', name: 'Project Admin' },
      status: 'ACTIVE',
    });
    const empty = await createProject(ctx, 'Empty', []);
    expect(
      (
        await repos.projects.getDetail(
          createAuthorizedProjectScope(ctx.ws.id, empty.id),
          ctx.viewer,
        )
      )?.environmentCount,
    ).toBe(0);
  });

  it('filters, searches, sorts and paginates with exact totals', async () => {
    const ctx = await setup('list');
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      await createProject(ctx, name, []);
    }
    const base = { status: 'active' as const, favoritesOnly: false, sort: 'name' as const };
    const page1 = await repos.projects.list(ctx.scope, ctx.viewer, {
      ...base,
      page: 1,
      pageSize: 2,
    });
    const page3 = await repos.projects.list(ctx.scope, ctx.viewer, {
      ...base,
      page: 3,
      pageSize: 2,
    });
    expect(page1.items.map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
    expect(page3.items.map((p) => p.name)).toEqual(['Echo']);
    expect(page1.total).toBe(5);

    const search = await repos.projects.list(ctx.scope, ctx.viewer, {
      ...base,
      q: 'ARL',
      page: 1,
      pageSize: 10,
    });
    expect(search.items.map((p) => p.name)).toEqual(['Charlie']);

    const delta = await repos.projects.findBySlug(ctx.scope, 'delta');
    const deltaScope = createAuthorizedProjectScope(ctx.ws.id, delta?.id ?? '');
    await repos.projects.setArchived(deltaScope, true);
    await repos.projects.setFavorite(deltaScope, ctx.owner.id, true);
    const archived = await repos.projects.list(ctx.scope, ctx.viewer, {
      ...base,
      status: 'archived',
      page: 1,
      pageSize: 10,
    });
    expect(archived.items.map((p) => p.name)).toEqual(['Delta']);
    expect(archived.items[0]?.isFavorite).toBe(true);
    const favorites = await repos.projects.list(ctx.scope, ctx.viewer, {
      ...base,
      status: 'all',
      favoritesOnly: true,
      page: 1,
      pageSize: 10,
    });
    expect(favorites.total).toBe(1);
  });

  it('orders recent projects by last visit', async () => {
    const ctx = await setup('recent');
    const a = await createProject(ctx, 'Apple', []);
    const b = await createProject(ctx, 'Banana', []);
    await createProject(ctx, 'Cherry', []);
    await repos.projects.recordVisit(
      createAuthorizedProjectScope(ctx.ws.id, b.id),
      ctx.owner.id,
      new Date('2026-01-01'),
    );
    await repos.projects.recordVisit(
      createAuthorizedProjectScope(ctx.ws.id, a.id),
      ctx.owner.id,
      new Date('2026-02-01'),
    );
    const recent = await repos.projects.list(ctx.scope, ctx.viewer, {
      status: 'active',
      favoritesOnly: false,
      sort: 'recent',
      page: 1,
      pageSize: 10,
    });
    expect(recent.items.map((p) => p.name)).toEqual(['Apple', 'Banana']);
    expect(recent.total).toBe(2);
  });

  it('shows only explicit memberships to users who do not administer all projects', async () => {
    const ctx = await setup('vis');
    await createProject(ctx, 'Hidden', []);
    const member = await db.user.create({ data: userData('m@example.test') });
    const role = await repos.roles.findWorkspaceRole(ctx.scope, 'member');
    const membershipId = await repos.memberships.add(ctx.scope, member.id, role?.id ?? '');
    const viewer = {
      userId: member.id,
      workspaceMembershipId: membershipId,
      seesAllProjects: false,
    };
    const visible = await repos.projects.list(ctx.scope, viewer, {
      status: 'all',
      favoritesOnly: false,
      sort: 'name',
      page: 1,
      pageSize: 10,
    });
    expect(visible.total).toBe(0);
  });

  it('enforces lifecycle consistency, slug uniqueness and visual identifier formats', async () => {
    const ctx = await setup('rules');
    const project = await createProject(ctx, 'Rules', []);
    const archivedWithoutDate = await rejection(
      db.project.update({ where: { id: project.id }, data: { status: 'ARCHIVED' } }),
    );
    expect(getConstraintViolation(archivedWithoutDate)?.constraint).toBe(
      'projects_archive_state_chk',
    );
    const badColor = await rejection(
      db.project.update({ where: { id: project.id }, data: { color: 'Red!' } }),
    );
    expect(getConstraintViolation(badColor)?.constraint).toBe('projects_color_format_chk');
    const duplicate = await rejection(createProject(ctx, 'Rules', []));
    expect(getConstraintViolation(duplicate)?.constraint).toBe('projects_workspace_slug_live_key');

    // A deleted project frees its slug.
    await repos.projects.softDelete(createAuthorizedProjectScope(ctx.ws.id, project.id));
    await expect(createProject(ctx, 'Rules', [])).resolves.toHaveProperty('id');
  });
});

describe('environments', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('keeps names unique per project case-insensitively, but not across projects', async () => {
    const ctx = await setup('envs');
    const a = await createProject(ctx, 'A', [env('QA', 0)]);
    await createProject(ctx, 'B', [env('QA', 0)]);
    const scope = createAuthorizedProjectScope(ctx.ws.id, a.id);
    const clash = await rejection(
      repos.environments.create(scope, { ...env('qa', 10), slug: 'qa-2' }, ctx.owner.id),
    );
    expect(getConstraintViolation(clash)?.constraint).toBe('environments_project_name_live_key');
  });

  it('renames without changing the stable id or slug, and archives read-only', async () => {
    const ctx = await setup('rename');
    const p = await createProject(ctx, 'Rename', [env('QA', 0)]);
    const pScope = createAuthorizedProjectScope(ctx.ws.id, p.id);
    const [qa] = await repos.environments.listByProject(ctx.scope, p.id);
    const eScope = createAuthorizedEnvironmentScope(ctx.ws.id, p.id, qa?.id ?? '');
    expect(await repos.environments.update(eScope, { name: 'Quality Assurance' })).toBe(true);
    const renamed = await repos.environments.getDetail(eScope);
    expect(renamed).toMatchObject({ id: qa?.id, slug: 'qa', name: 'Quality Assurance' });
    expect(renamed?.expectedKeys).toEqual([{ key: 'DATABASE_URL' }]);

    expect(await repos.environments.setArchived(eScope, true)).toBe(true);
    expect(await repos.environments.update(eScope, { name: 'Nope' })).toBe(false);
    expect(await repos.environments.setArchived(eScope, true)).toBe(false);
    expect(await repos.environments.setArchived(eScope, false)).toBe(true);
    expect(await repos.environments.nextSortOrder(pScope)).toBe(10);
  });

  it('never resolves an environment through another project or workspace', async () => {
    const one = await setup('one');
    const two = await setup('two');
    const p1 = await createProject(one, 'P1', [env('Development', 0)]);
    const p2 = await createProject(two, 'P2', [env('Development', 0)]);
    const [e1] = await repos.environments.listByProject(one.scope, p1.id);
    // Wrong project, wrong workspace: indistinguishable from missing.
    expect(
      await repos.access.loadEnvironment(one.ws.id, p2.id, e1?.id ?? '', one.membershipId),
    ).toBeNull();
    expect(
      await repos.access.loadEnvironment(two.ws.id, p1.id, e1?.id ?? '', two.membershipId),
    ).toBeNull();
    expect(await repos.access.loadProject(two.ws.id, p1.id, two.membershipId)).toBeNull();
    expect(
      await repos.environments.getDetail(
        createAuthorizedEnvironmentScope(one.ws.id, p2.id, e1?.id ?? ''),
      ),
    ).toBeNull();
  });

  it('reorders only the project’s own environments', async () => {
    const ctx = await setup('order');
    const p = await createProject(ctx, 'Order', [env('A', 0), env('B', 10), env('C', 20)]);
    const other = await createProject(ctx, 'Other', [env('X', 0)]);
    const pScope = createAuthorizedProjectScope(ctx.ws.id, p.id);
    const envs = await repos.environments.listByProject(ctx.scope, p.id);
    const [x] = await repos.environments.listByProject(ctx.scope, other.id);
    const ids = envs.map((e) => e.id);
    expect(await repos.environments.reorder(pScope, [...ids].reverse())).toBe(true);
    expect((await repos.environments.listByProject(ctx.scope, p.id)).map((e) => e.name)).toEqual([
      'C',
      'B',
      'A',
    ]);
    expect(await repos.environments.reorder(pScope, [ids[0] ?? '', x?.id ?? ''])).toBe(false);
  });

  it('rejects malformed expected keys and inconsistent archive state', async () => {
    const ctx = await setup('keys');
    const p = await createProject(ctx, 'Keys', [env('Dev', 0)]);
    const [dev] = await repos.environments.listByProject(ctx.scope, p.id);
    const notArray = await rejection(
      db.environment.update({ where: { id: dev?.id ?? '' }, data: { expectedKeys: { key: 'X' } } }),
    );
    expect(getConstraintViolation(notArray)?.constraint).toBe('environments_expected_keys_chk');
    const restoredWithDate = await rejection(
      db.environment.update({ where: { id: dev?.id ?? '' }, data: { archivedAt: new Date() } }),
    );
    expect(getConstraintViolation(restoredWithDate)?.constraint).toBe(
      'environments_archive_state_chk',
    );
  });

  it('pages activity with a stable keyset cursor', async () => {
    const ctx = await setup('activity');
    const p = await createProject(ctx, 'Activity', []);
    const pScope = createAuthorizedProjectScope(ctx.ws.id, p.id);
    for (let i = 0; i < 5; i++) {
      await repos.audit.append({
        workspaceId: ctx.ws.id,
        projectId: p.id,
        actorUserId: ctx.owner.id,
        action: `project.test_${String(i)}`,
        outcome: 'SUCCESS',
        resourceType: 'project',
        resourceId: p.id,
      });
    }
    const first = await repos.activity.listForProject(pScope, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.items[0]?.actor?.email).toBe('activity-owner@example.test');
    const second = await repos.activity.listForProject(pScope, {
      limit: 3,
      cursor: first.next ?? undefined,
    });
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items].map((e) => e.action);
    expect(new Set(all).size).toBe(5);
  });
});
