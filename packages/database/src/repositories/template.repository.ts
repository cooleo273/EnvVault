import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { WorkspaceScope } from '../scope.js';

export interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  /** Validated by the API against the shared template entry schema. */
  environments: Prisma.JsonValue;
  createdAt: Date;
}

const select = {
  id: true,
  name: true,
  description: true,
  environments: true,
  createdAt: true,
} as const;

/** Workspace-defined environment templates (names, kinds, defaults, key names; never values). */
export class TemplateRepository {
  constructor(private readonly db: DbClient) {}

  list(scope: WorkspaceScope): Promise<TemplateRecord[]> {
    return this.db.environmentTemplate.findMany({
      where: { workspaceId: scope.workspaceId },
      select,
      orderBy: { name: 'asc' },
    });
  }

  find(scope: WorkspaceScope, templateId: string): Promise<TemplateRecord | null> {
    return this.db.environmentTemplate.findFirst({
      where: { id: templateId, workspaceId: scope.workspaceId },
      select,
    });
  }

  create(
    scope: WorkspaceScope,
    data: { name: string; description?: string | undefined; environments: Prisma.InputJsonValue },
  ): Promise<TemplateRecord> {
    return this.db.environmentTemplate.create({
      data: {
        workspaceId: scope.workspaceId,
        name: data.name.trim(),
        description: data.description?.trim() ? data.description.trim() : null,
        environments: data.environments,
      },
      select,
    });
  }

  async remove(scope: WorkspaceScope, templateId: string): Promise<boolean> {
    const result = await this.db.environmentTemplate.deleteMany({
      where: { id: templateId, workspaceId: scope.workspaceId },
    });
    return result.count === 1;
  }
}
