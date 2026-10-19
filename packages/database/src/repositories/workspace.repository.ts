import { PERMISSION_KEYS } from '@envvault/shared';
import { ensurePermissionCatalog, provisionNewWorkspaceRoles } from '../catalog/provisioning.js';
import type { DbClient } from '../client.js';
import type { WorkspaceType } from '../generated/prisma/enums.js';
import type { WorkspaceScope } from '../scope.js';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  type: WorkspaceType;
  archivedAt: Date | null;
  role: { key: string; name: string };
  createdAt: Date;
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  type: WorkspaceType;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  projectCount: number;
  memberCount: number;
}

export interface CreateWorkspaceData {
  name: string;
  slug: string;
  description?: string | null | undefined;
  type?: WorkspaceType | undefined;
  ownerUserId: string;
}

const workspaceFields = {
  id: true,
  name: true,
  slug: true,
  description: true,
  type: true,
  archivedAt: true,
  createdAt: true,
} as const;

/** Lower-case, dash-separated slug candidate from a display name. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'workspace';
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export class WorkspaceRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Live workspaces in which the user has an ACTIVE membership. Archived
   * workspaces are included only when asked for.
   */
  async listForUser(
    userId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<WorkspaceSummary[]> {
    const memberships = await this.db.workspaceMembership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        workspace: {
          deletedAt: null,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
      },
      select: {
        role: { select: { key: true, name: true } },
        workspace: { select: workspaceFields },
      },
      orderBy: { workspace: { name: 'asc' } },
    });
    return memberships.map(({ role, workspace }) => ({ ...workspace, role }));
  }

  /** True when no live workspace uses the slug. */
  async isSlugAvailable(slug: string): Promise<boolean> {
    const existing = await this.db.workspace.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    return existing === null;
  }

  /**
   * Creates a workspace with the built-in roles and makes `ownerUserId` its
   * owner. Must run inside a transaction (see withTransaction). Uses a
   * constant number of statements so it stays fast on high-latency links
   * (e.g. a remote Neon database).
   */
  async createWithOwner(input: CreateWorkspaceData): Promise<WorkspaceSummary> {
    const permissionCount = await this.db.permission.count();
    if (permissionCount < PERMISSION_KEYS.length) {
      await ensurePermissionCatalog(this.db);
    }
    const workspace = await this.db.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: emptyToNull(input.description) ?? null,
        type: input.type ?? 'TEAM',
        createdById: input.ownerUserId,
      },
      select: workspaceFields,
    });
    const roles = await provisionNewWorkspaceRoles(this.db, workspace.id);
    const ownerRoleId = roles.get('owner');
    if (ownerRoleId === undefined) throw new Error('Owner role was not provisioned');
    await this.db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: input.ownerUserId, roleId: ownerRoleId },
    });
    return { ...workspace, role: { key: 'owner', name: 'Owner' } };
  }

  async getDetail(scope: WorkspaceScope): Promise<WorkspaceDetail | null> {
    const workspace = await this.db.workspace.findFirst({
      where: { id: scope.workspaceId, deletedAt: null },
      select: {
        ...workspaceFields,
        updatedAt: true,
        _count: {
          select: {
            projects: { where: { deletedAt: null } },
            memberships: { where: { status: 'ACTIVE' } },
          },
        },
      },
    });
    if (!workspace) return null;
    const { _count, ...rest } = workspace;
    return { ...rest, projectCount: _count.projects, memberCount: _count.memberships };
  }

  /** Updates name/description of a live, non-archived workspace. */
  async update(
    scope: WorkspaceScope,
    data: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<boolean> {
    const description = emptyToNull(data.description);
    const result = await this.db.workspace.updateMany({
      where: { id: scope.workspaceId, deletedAt: null, archivedAt: null },
      data: {
        ...(data.name === undefined ? {} : { name: data.name.trim() }),
        ...(description === undefined ? {} : { description }),
      },
    });
    return result.count === 1;
  }

  /** Makes the workspace read-only. Returns false if it was already archived. */
  async archive(scope: WorkspaceScope, now = new Date()): Promise<boolean> {
    const result = await this.db.workspace.updateMany({
      where: { id: scope.workspaceId, deletedAt: null, archivedAt: null },
      data: { archivedAt: now },
    });
    return result.count === 1;
  }

  /** Returns false if the workspace was not archived. */
  async restore(scope: WorkspaceScope): Promise<boolean> {
    const result = await this.db.workspace.updateMany({
      where: { id: scope.workspaceId, deletedAt: null, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    return result.count === 1;
  }

  /**
   * Serialises membership changes for one workspace (row lock until commit).
   * Call first in transactions that check-then-change owners or members.
   */
  async lockForUpdate(scope: WorkspaceScope): Promise<void> {
    await this.db
      .$queryRaw`SELECT 1 FROM "workspaces" WHERE "id" = ${scope.workspaceId}::uuid FOR UPDATE`;
  }

  /** Starts the recovery window; data is purged later by a maintenance job. */
  async softDelete(scope: WorkspaceScope, now = new Date()): Promise<boolean> {
    const result = await this.db.workspace.updateMany({
      where: { id: scope.workspaceId, deletedAt: null },
      data: { deletedAt: now },
    });
    return result.count === 1;
  }
}
