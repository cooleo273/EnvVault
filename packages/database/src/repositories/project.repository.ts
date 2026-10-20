import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { EnvironmentKind, ProjectStatus } from '../generated/prisma/enums.js';
import type { ProjectScope, WorkspaceScope } from '../scope.js';

export interface ProjectViewer {
  userId: string;
  workspaceMembershipId: string;
  /** Workspace owners/admins see every project; others only their memberships. */
  seesAllProjects: boolean;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string;
  color: string;
  status: ProjectStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  environmentCount: number;
  protectedEnvironmentCount: number;
  memberCount: number;
  isFavorite: boolean;
  lastVisitedAt: Date | null;
  /** The viewer's explicit project role, if any. */
  role: { key: string; name: string } | null;
  createdBy: { displayName: string | null; email: string } | null;
}

export interface ProjectListQuery {
  q?: string | undefined;
  status: 'active' | 'archived' | 'all';
  favoritesOnly: boolean;
  sort: 'name' | 'updated' | 'created' | 'recent';
  order?: 'asc' | 'desc' | undefined;
  page: number;
  pageSize: number;
}

export interface NewEnvironmentData {
  name: string;
  slug: string;
  kind: EnvironmentKind;
  description?: string | null | undefined;
  color: string;
  icon?: string | null | undefined;
  isProtected: boolean;
  requiredApprovals?: number | undefined;
  expectedKeys: { key: string; description?: string | undefined }[];
  sortOrder: number;
}

export interface CreateProjectData {
  name: string;
  slug: string;
  description?: string | null | undefined;
  icon: string;
  color: string;
  createdById: string;
  /** The creator's workspace membership; it becomes Project Admin. */
  adminWorkspaceMembershipId: string;
  environments: NewEnvironmentData[];
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function viewerSelect(viewer: ProjectViewer) {
  return {
    id: true,
    workspaceId: true,
    name: true,
    slug: true,
    description: true,
    icon: true,
    color: true,
    status: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    createdBy: { select: { displayName: true, email: true } },
    _count: {
      select: {
        environments: { where: { deletedAt: null } },
        memberships: true,
      },
    },
    favorites: { where: { userId: viewer.userId }, select: { userId: true } },
    visits: { where: { userId: viewer.userId }, select: { visitedAt: true } },
    memberships: {
      where: { workspaceMembershipId: viewer.workspaceMembershipId },
      select: { role: { select: { key: true, name: true } } },
    },
  } as const satisfies Prisma.ProjectSelect;
}

type ProjectRow = Prisma.ProjectGetPayload<{ select: ReturnType<typeof viewerSelect> }>;

function toRecord(row: ProjectRow, protectedCounts: Map<string, number>): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    color: row.color,
    status: row.status,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    environmentCount: row._count.environments,
    protectedEnvironmentCount: protectedCounts.get(row.id) ?? 0,
    memberCount: row._count.memberships,
    isFavorite: row.favorites.length > 0,
    lastVisitedAt: row.visits[0]?.visitedAt ?? null,
    role: row.memberships[0]?.role ?? null,
    createdBy: row.createdBy,
  };
}

/**
 * Projects of one workspace. Every query is constrained by the scope's
 * workspace (and project), and only live (not soft-deleted) rows are visible.
 * Listing uses a constant number of queries regardless of page size.
 */
export class ProjectRepository {
  constructor(private readonly db: DbClient) {}

  /** Raw lookup for trusted callers (e.g. seeds, tests). */
  findById(scope: WorkspaceScope, projectId: string) {
    return this.db.project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId, deletedAt: null },
    });
  }

  findBySlug(scope: WorkspaceScope, slug: string) {
    return this.db.project.findFirst({
      where: { slug, workspaceId: scope.workspaceId, deletedAt: null },
    });
  }

  private visibilityWhere(scope: WorkspaceScope, viewer: ProjectViewer): Prisma.ProjectWhereInput {
    return {
      workspaceId: scope.workspaceId,
      deletedAt: null,
      ...(viewer.seesAllProjects
        ? {}
        : { memberships: { some: { workspaceMembershipId: viewer.workspaceMembershipId } } }),
    };
  }

  private async protectedCounts(projectIds: string[]): Promise<Map<string, number>> {
    if (projectIds.length === 0) return new Map();
    const groups = await this.db.environment.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, deletedAt: null, isProtected: true },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.projectId, g._count._all]));
  }

  async list(
    scope: WorkspaceScope,
    viewer: ProjectViewer,
    query: ProjectListQuery,
  ): Promise<{ items: ProjectRecord[]; total: number }> {
    const q = query.q?.trim();
    const where: Prisma.ProjectWhereInput = {
      ...this.visibilityWhere(scope, viewer),
      ...(query.status === 'all'
        ? {}
        : { status: query.status === 'active' ? 'ACTIVE' : 'ARCHIVED' }),
      ...(query.favoritesOnly ? { favorites: { some: { userId: viewer.userId } } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q.toLowerCase() } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.pageSize;

    if (query.sort === 'recent') {
      // Most recently opened first; never-opened projects are excluded.
      const recentWhere: Prisma.ProjectWhereInput = {
        ...where,
        visits: { some: { userId: viewer.userId } },
      };
      const [visits, total] = await Promise.all([
        this.db.projectVisit.findMany({
          where: { userId: viewer.userId, workspaceId: scope.workspaceId, project: recentWhere },
          orderBy: { visitedAt: 'desc' },
          skip,
          take: query.pageSize,
          select: { projectId: true },
        }),
        this.db.project.count({ where: recentWhere }),
      ]);
      const ids = visits.map((v) => v.projectId);
      const rows = await this.db.project.findMany({
        where: { id: { in: ids }, workspaceId: scope.workspaceId },
        select: viewerSelect(viewer),
      });
      const counts = await this.protectedCounts(ids);
      const byId = new Map(rows.map((r) => [r.id, toRecord(r, counts)]));
      return { items: ids.flatMap((id) => byId.get(id) ?? []), total };
    }

    const direction = query.order ?? (query.sort === 'name' ? 'asc' : 'desc');
    const orderBy: Prisma.ProjectOrderByWithRelationInput[] =
      query.sort === 'name'
        ? [{ name: direction }, { id: 'asc' }]
        : query.sort === 'created'
          ? [{ createdAt: direction }, { id: 'asc' }]
          : [{ updatedAt: direction }, { id: 'asc' }];
    const [rows, total] = await Promise.all([
      this.db.project.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
        select: viewerSelect(viewer),
      }),
      this.db.project.count({ where }),
    ]);
    const counts = await this.protectedCounts(rows.map((r) => r.id));
    return { items: rows.map((r) => toRecord(r, counts)), total };
  }

  async getDetail(scope: ProjectScope, viewer: ProjectViewer): Promise<ProjectRecord | null> {
    const row = await this.db.project.findFirst({
      where: { id: scope.projectId, workspaceId: scope.workspaceId, deletedAt: null },
      select: viewerSelect(viewer),
    });
    if (!row) return null;
    return toRecord(row, await this.protectedCounts([row.id]));
  }

  /** Slug candidates already used by live projects of the workspace. */
  async usedSlugs(scope: WorkspaceScope, base: string): Promise<Set<string>> {
    const rows = await this.db.project.findMany({
      where: { workspaceId: scope.workspaceId, deletedAt: null, slug: { startsWith: base } },
      select: { slug: true },
    });
    return new Set(rows.map((r) => r.slug));
  }

  /**
   * Creates a project, makes the creator its Project Admin and creates the
   * initial environments. Must run inside a transaction.
   */
  async create(scope: WorkspaceScope, data: CreateProjectData): Promise<{ id: string }> {
    const adminRole = await this.db.role.findFirst({
      where: { workspaceId: scope.workspaceId, key: 'project-admin', scope: 'PROJECT' },
      select: { id: true },
    });
    if (!adminRole) throw new Error('The project-admin role is missing; run db:sync-catalog');
    const project = await this.db.project.create({
      data: {
        workspaceId: scope.workspaceId,
        name: data.name.trim(),
        slug: data.slug,
        description: emptyToNull(data.description) ?? null,
        icon: data.icon,
        color: data.color,
        createdById: data.createdById,
      },
      select: { id: true },
    });
    await this.db.projectMembership.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: project.id,
        workspaceMembershipId: data.adminWorkspaceMembershipId,
        roleId: adminRole.id,
      },
    });
    if (data.environments.length > 0) {
      await this.db.environment.createMany({
        data: data.environments.map((env) => ({
          workspaceId: scope.workspaceId,
          projectId: project.id,
          name: env.name.trim(),
          slug: env.slug,
          kind: env.kind,
          description: emptyToNull(env.description) ?? null,
          color: env.color,
          icon: env.icon ?? null,
          isProtected: env.isProtected,
          requiredApprovals: env.isProtected ? (env.requiredApprovals ?? 0) : 0,
          expectedKeys: env.expectedKeys,
          sortOrder: env.sortOrder,
          createdById: data.createdById,
        })),
      });
    }
    return project;
  }

  /** Updates metadata of an ACTIVE project. False if archived or gone. */
  async update(
    scope: ProjectScope,
    data: {
      name?: string | undefined;
      description?: string | null | undefined;
      icon?: string | undefined;
      color?: string | undefined;
    },
  ): Promise<boolean> {
    const description = emptyToNull(data.description);
    const result = await this.db.project.updateMany({
      where: {
        id: scope.projectId,
        workspaceId: scope.workspaceId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      data: {
        ...(data.name === undefined ? {} : { name: data.name.trim() }),
        ...(description === undefined ? {} : { description }),
        ...(data.icon === undefined ? {} : { icon: data.icon }),
        ...(data.color === undefined ? {} : { color: data.color }),
      },
    });
    return result.count === 1;
  }

  async setArchived(scope: ProjectScope, archived: boolean, now = new Date()): Promise<boolean> {
    const result = await this.db.project.updateMany({
      where: {
        id: scope.projectId,
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

  /**
   * Soft delete. Environments, memberships, grants and audit history are kept
   * (hidden with the project) for the recovery window; a maintenance job
   * purges them later. No cascading delete happens here.
   */
  async softDelete(scope: ProjectScope, now = new Date()): Promise<boolean> {
    const result = await this.db.project.updateMany({
      where: { id: scope.projectId, workspaceId: scope.workspaceId, deletedAt: null },
      data: { deletedAt: now },
    });
    return result.count === 1;
  }

  async setFavorite(scope: ProjectScope, userId: string, favorite: boolean): Promise<void> {
    if (favorite) {
      await this.db.projectFavorite.upsert({
        where: { userId_projectId: { userId, projectId: scope.projectId } },
        create: { userId, workspaceId: scope.workspaceId, projectId: scope.projectId },
        update: {},
      });
    } else {
      await this.db.projectFavorite.deleteMany({ where: { userId, projectId: scope.projectId } });
    }
  }

  async recordVisit(scope: ProjectScope, userId: string, now = new Date()): Promise<void> {
    await this.db.projectVisit.upsert({
      where: { userId_projectId: { userId, projectId: scope.projectId } },
      create: {
        userId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        visitedAt: now,
      },
      update: { visitedAt: now },
    });
  }
}
