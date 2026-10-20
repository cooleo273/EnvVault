import type { DbClient } from '../client.js';
import type { Environment, Prisma } from '../generated/prisma/client.js';
import type { EnvironmentKind, EnvironmentStatus } from '../generated/prisma/enums.js';
import type { EnvironmentScope, ProjectScope, WorkspaceScope } from '../scope.js';
import type { NewEnvironmentData } from './project.repository.js';

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  description: string | null;
  color: string;
  icon: string | null;
  sortOrder: number;
  isProtected: boolean;
  requiredApprovals: number;
  status: EnvironmentStatus;
  archivedAt: Date | null;
  expectedKeys: { key: string; description?: string | undefined }[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: { displayName: string | null; email: string } | null;
}

/** An environment plus the viewer's own grants on it (for permission evaluation). */
export interface EnvironmentWithGrants extends EnvironmentRecord {
  grants: { effect: 'ALLOW' | 'DENY'; expiresAt: Date | null; permissions: string[] }[];
}

const recordSelect = {
  id: true,
  projectId: true,
  name: true,
  slug: true,
  kind: true,
  description: true,
  color: true,
  icon: true,
  sortOrder: true,
  isProtected: true,
  requiredApprovals: true,
  status: true,
  archivedAt: true,
  expectedKeys: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { displayName: true, email: true } },
} as const satisfies Prisma.EnvironmentSelect;

type RecordRow = Prisma.EnvironmentGetPayload<{ select: typeof recordSelect }>;

function parseKeys(value: Prisma.JsonValue): EnvironmentRecord['expectedKeys'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.key === 'string') {
      const description = typeof item.description === 'string' ? item.description : undefined;
      return [{ key: item.key, ...(description ? { description } : {}) }];
    }
    return [];
  });
}

function toRecord(row: RecordRow): EnvironmentRecord {
  return { ...row, expectedKeys: parseKeys(row.expectedKeys) };
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Environments of one project. All methods are constrained by the scope's
 * workspace and project and by the parent project being live.
 */
export class EnvironmentRepository {
  constructor(private readonly db: DbClient) {}

  /** Live environments of a project (trusted callers; no permission filtering). */
  listByProject(scope: WorkspaceScope, projectId: string): Promise<Environment[]> {
    return this.db.environment.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId,
        deletedAt: null,
        project: { deletedAt: null },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findBySlug(scope: WorkspaceScope, projectId: string, slug: string): Promise<Environment | null> {
    return this.db.environment.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId,
        slug,
        deletedAt: null,
        project: { deletedAt: null },
      },
    });
  }

  /**
   * Environments matching the filters, each with the viewer's own grants, in
   * display order. One query; the caller evaluates permissions and paginates
   * (projects hold dozens of environments, capped at `limit`).
   */
  async listWithGrants(
    scope: ProjectScope,
    workspaceMembershipId: string,
    filters: {
      q?: string | undefined;
      status: 'active' | 'archived' | 'all';
      kind?: EnvironmentKind | undefined;
    },
    limit = 1000,
  ): Promise<EnvironmentWithGrants[]> {
    const q = filters.q?.trim();
    const rows = await this.db.environment.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        deletedAt: null,
        ...(filters.status === 'all'
          ? {}
          : { status: filters.status === 'active' ? 'ACTIVE' : 'ARCHIVED' }),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { slug: { contains: q.toLowerCase() } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        ...recordSelect,
        accessPolicies: {
          where: { workspaceMembershipId },
          select: {
            effect: true,
            expiresAt: true,
            role: {
              select: { permissions: { select: { permission: { select: { key: true } } } } },
            },
          },
        },
      },
    });
    return rows.map(({ accessPolicies, ...row }) => ({
      ...toRecord(row),
      grants: accessPolicies.map((p) => ({
        effect: p.effect,
        expiresAt: p.expiresAt,
        permissions: p.role.permissions.map((rp) => rp.permission.key),
      })),
    }));
  }

  async getDetail(scope: EnvironmentScope): Promise<EnvironmentRecord | null> {
    const row = await this.db.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        deletedAt: null,
      },
      select: recordSelect,
    });
    return row ? toRecord(row) : null;
  }

  /** Slugs and lower-cased names already used by live environments of the project. */
  async usedIdentifiers(scope: ProjectScope): Promise<{ slugs: Set<string>; names: Set<string> }> {
    const rows = await this.db.environment.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, deletedAt: null },
      select: { slug: true, name: true },
    });
    return {
      slugs: new Set(rows.map((r) => r.slug)),
      names: new Set(rows.map((r) => r.name.toLowerCase())),
    };
  }

  async nextSortOrder(scope: ProjectScope): Promise<number> {
    const result = await this.db.environment.aggregate({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, deletedAt: null },
      _max: { sortOrder: true },
    });
    return (result._max.sortOrder ?? -10) + 10;
  }

  async create(
    scope: ProjectScope,
    data: NewEnvironmentData,
    createdById: string,
  ): Promise<{ id: string }> {
    return this.db.environment.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        name: data.name.trim(),
        slug: data.slug,
        kind: data.kind,
        description: emptyToNull(data.description) ?? null,
        color: data.color,
        icon: data.icon ?? null,
        isProtected: data.isProtected,
        requiredApprovals: data.isProtected ? (data.requiredApprovals ?? 0) : 0,
        expectedKeys: data.expectedKeys,
        sortOrder: data.sortOrder,
        createdById,
      },
      select: { id: true },
    });
  }

  /** Metadata of an ACTIVE environment. False if archived or gone. */
  async update(
    scope: EnvironmentScope,
    data: {
      name?: string | undefined;
      description?: string | null | undefined;
      kind?: EnvironmentKind | undefined;
      color?: string | undefined;
      icon?: string | null | undefined;
      expectedKeys?: { key: string; description?: string | undefined }[] | undefined;
    },
  ): Promise<boolean> {
    const description = emptyToNull(data.description);
    const result = await this.db.environment.updateMany({
      where: this.activeWhere(scope),
      data: {
        ...(data.name === undefined ? {} : { name: data.name.trim() }),
        ...(description === undefined ? {} : { description }),
        ...(data.kind === undefined ? {} : { kind: data.kind }),
        ...(data.color === undefined ? {} : { color: data.color }),
        ...(data.icon === undefined ? {} : { icon: data.icon }),
        ...(data.expectedKeys === undefined ? {} : { expectedKeys: data.expectedKeys }),
      },
    });
    return result.count === 1;
  }

  async setProtection(
    scope: EnvironmentScope,
    isProtected: boolean,
    requiredApprovals: number,
  ): Promise<boolean> {
    const result = await this.db.environment.updateMany({
      where: this.activeWhere(scope),
      data: { isProtected, requiredApprovals: isProtected ? requiredApprovals : 0 },
    });
    return result.count === 1;
  }

  async setArchived(
    scope: EnvironmentScope,
    archived: boolean,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.db.environment.updateMany({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        deletedAt: null,
        status: archived ? 'ACTIVE' : 'ARCHIVED',
      },
      data: archived
        ? { status: 'ARCHIVED', archivedAt: now }
        : { status: 'ACTIVE', archivedAt: null },
    });
    return result.count === 1;
  }

  /** Soft delete; grants and audit history are kept until the purge job runs. */
  async softDelete(scope: EnvironmentScope, now = new Date()): Promise<boolean> {
    const result = await this.db.environment.updateMany({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        deletedAt: null,
      },
      data: { deletedAt: now },
    });
    return result.count === 1;
  }

  /**
   * Applies a new display order. Every id must be a live environment of the
   * project; returns false otherwise (and nothing changes in the transaction).
   */
  async reorder(scope: ProjectScope, environmentIds: string[]): Promise<boolean> {
    const found = await this.db.environment.count({
      where: {
        id: { in: environmentIds },
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        deletedAt: null,
      },
    });
    if (found !== new Set(environmentIds).size || found !== environmentIds.length) return false;
    await Promise.all(
      environmentIds.map((id, index) =>
        this.db.environment.updateMany({
          where: { id, projectId: scope.projectId, workspaceId: scope.workspaceId },
          data: { sortOrder: index * 10 },
        }),
      ),
    );
    return true;
  }

  private activeWhere(scope: EnvironmentScope): Prisma.EnvironmentWhereInput {
    return {
      id: scope.environmentId,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      deletedAt: null,
      status: 'ACTIVE',
    };
  }
}
