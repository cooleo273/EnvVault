import type { DbClient } from '../client.js';
import type { Environment, Project } from '../generated/prisma/client.js';
import type { WorkspaceScope } from '../scope.js';

/**
 * Tenant-scoped repository pattern: every method takes a WorkspaceScope and
 * constrains the query by `scope.workspaceId`, so a row from another tenant is
 * indistinguishable from a missing row. Soft-deleted rows are excluded.
 */
export class ProjectRepository {
  constructor(private readonly db: DbClient) {}

  findById(scope: WorkspaceScope, projectId: string): Promise<Project | null> {
    return this.db.project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId, deletedAt: null },
    });
  }

  findBySlug(scope: WorkspaceScope, slug: string): Promise<Project | null> {
    return this.db.project.findFirst({
      where: { slug, workspaceId: scope.workspaceId, deletedAt: null },
    });
  }
}

export class EnvironmentRepository {
  constructor(private readonly db: DbClient) {}

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
}
