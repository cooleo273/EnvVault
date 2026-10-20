import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  createRepositories,
  decodeActivityCursor,
  encodeActivityCursor,
  slugify,
  withTransaction,
  workspaceScopeOf,
} from '@envvault/database';
import {
  type ActivityPage,
  activityQuerySchema,
  createProjectInputSchema,
  duplicateProjectInputSchema,
  listProjectsQuerySchema,
  type Paginated,
  PROJECT_ERROR_CODES,
  type ProjectDetail,
  type ProjectSummary,
  type UpdateProjectInput,
  updateProjectInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireProjectPermission,
  RequireStepUp,
  RequireWorkspacePermission,
} from '../auth/auth.decorators.js';
import type {
  AuthenticatedRequest,
  AuthorizedProject,
  AuthorizedWorkspace,
  Principal,
} from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { DatabaseService } from '../database/database.service.js';
import {
  mapConstraintError,
  notFound,
  planEnvironments,
  toProjectDetail,
  toProjectSummary,
  uniqueSlug,
} from './project.helpers.js';

const SLUG_ATTEMPTS = 3;

/**
 * Projects of a workspace. Workspace owners/admins administer every project
 * (never with secret permissions); everyone else sees only projects they are
 * an explicit member of. Every state change writes an audit event in the
 * same transaction.
 */
@Controller({ path: 'workspaces/:workspaceId/projects', version: '1' })
export class ProjectsController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @RequireWorkspacePermission('workspace:read')
  @AllowArchived('workspace')
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Query(new ZodValidationPipe(listProjectsQuerySchema))
    query: z.output<typeof listProjectsQuerySchema>,
  ): Promise<Paginated<ProjectSummary>> {
    const seesAllProjects = workspace.membership.permissions.includes('project:read');
    const { items, total } = await createRepositories(this.database.client).projects.list(
      workspace.scope,
      {
        userId: principal.userId,
        workspaceMembershipId: workspace.membership.membershipId,
        seesAllProjects,
      },
      {
        q: query.q,
        status: query.status,
        favoritesOnly: query.favorite === 'true',
        sort: query.sort,
        order: query.order,
        page: query.page,
        pageSize: query.pageSize,
      },
    );
    return {
      items: items.map((p) => toProjectSummary(p, seesAllProjects)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** Creates a project; the creator becomes its Project Admin. */
  @Post()
  @RequireWorkspacePermission('project:create')
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(createProjectInputSchema))
    body: z.output<typeof createProjectInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; slug: string }> {
    const environments = planEnvironments(body.environments, {
      slugs: new Set(),
      names: new Set(),
    });
    return this.createProject(principal, workspace, request, {
      name: body.name,
      slug: body.slug,
      description: body.description,
      icon: body.icon,
      color: body.color,
      environments,
      audit: { action: 'project.created', metadata: {} },
    });
  }

  @Get(':projectId')
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
  ): Promise<ProjectDetail> {
    const record = await createRepositories(this.database.client).projects.getDetail(
      project.scope,
      {
        userId: principal.userId,
        workspaceMembershipId: workspace.membership.membershipId,
        seesAllProjects: project.access.source === 'workspace_role',
      },
    );
    if (!record) throw notFound();
    return toProjectDetail(record, project);
  }

  @Patch(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:update')
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(updateProjectInputSchema)) body: UpdateProjectInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.projects.update(project.scope, body))) throw notFound();
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: 'project.updated',
        outcome: 'SUCCESS',
        resourceType: 'project',
        resourceId: project.scope.projectId,
        requestId: requestIdOf(request),
        metadata: {
          fields: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined),
        },
      });
    });
  }

  @Post(':projectId/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:archive')
  async archive(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, project, request, true);
  }

  @Post(':projectId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:archive')
  @AllowArchived('project')
  async restore(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, project, request, false);
  }

  /**
   * Sensitive: soft-deletes the project (environments, members, grants and
   * audit history are kept for the recovery window; nothing cascades). Needs
   * `project:delete` + step-up, and `environment:protect` when the project has
   * protected environments.
   */
  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:delete')
  @AllowArchived('project')
  @RequireStepUp()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const detail = await repos.projects.getDetail(project.scope, {
        userId: principal.userId,
        workspaceMembershipId: workspace.membership.membershipId,
        seesAllProjects: true,
      });
      if (!detail) throw notFound();
      if (detail.protectedEnvironmentCount > 0 && !project.permissions.has('environment:protect')) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          PROJECT_ERROR_CODES.PROTECTION_REQUIRED,
          'This project has protected environments. Deleting it requires environment:protect.',
        );
      }
      if (!(await repos.projects.softDelete(project.scope))) throw notFound();
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: 'project.deleted',
        outcome: 'SUCCESS',
        resourceType: 'project',
        resourceId: project.scope.projectId,
        requestId: requestIdOf(request),
        metadata: {
          slug: detail.slug,
          environmentCount: detail.environmentCount,
          protectedEnvironmentCount: detail.protectedEnvironmentCount,
        },
      });
    });
  }

  /**
   * Copies metadata and the environment structure (names, kinds, protection,
   * colors, expected key names) into a new project. Never copies members,
   * grants or secret values. The caller becomes Project Admin of the copy.
   */
  @Post(':projectId/duplicate')
  @RequireProjectPermission('project:read')
  @AllowArchived('project')
  async duplicate(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(duplicateProjectInputSchema))
    body: z.output<typeof duplicateProjectInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; slug: string }> {
    if (!workspace.membership.permissions.includes('project:create')) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'You cannot create projects');
    }
    const repos = createRepositories(this.database.client);
    const source = await repos.projects.getDetail(project.scope, {
      userId: principal.userId,
      workspaceMembershipId: workspace.membership.membershipId,
      seesAllProjects: true,
    });
    if (!source) throw notFound();
    const sourceEnvironments = await repos.environments.listByProject(
      workspaceScopeOf(project.scope),
      project.scope.projectId,
    );
    const environments = sourceEnvironments.map((env) => ({
      name: env.name,
      slug: env.slug,
      kind: env.kind,
      description: env.description,
      color: env.color,
      icon: env.icon,
      isProtected: env.isProtected,
      requiredApprovals: env.requiredApprovals,
      expectedKeys: Array.isArray(env.expectedKeys)
        ? (env.expectedKeys as { key: string; description?: string }[])
        : [],
      sortOrder: env.sortOrder,
    }));
    return this.createProject(principal, workspace, request, {
      name: body.name,
      slug: body.slug,
      description: source.description ?? undefined,
      icon: source.icon,
      color: source.color,
      environments,
      audit: {
        action: 'project.duplicated',
        metadata: { sourceProjectId: project.scope.projectId },
      },
    });
  }

  @Put(':projectId/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async favorite(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
  ): Promise<void> {
    await createRepositories(this.database.client).projects.setFavorite(
      project.scope,
      principal.userId,
      true,
    );
  }

  @Delete(':projectId/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async unfavorite(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
  ): Promise<void> {
    await createRepositories(this.database.client).projects.setFavorite(
      project.scope,
      principal.userId,
      false,
    );
  }

  /** Records that the caller opened the project (for "recent projects"). Idempotent. */
  @Post(':projectId/visits')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async visit(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
  ): Promise<void> {
    await createRepositories(this.database.client).projects.recordVisit(
      project.scope,
      principal.userId,
    );
  }

  @Get(':projectId/activity')
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async activity(
    @CurrentProject() project: AuthorizedProject,
    @Query(new ZodValidationPipe(activityQuerySchema)) query: z.output<typeof activityQuerySchema>,
  ): Promise<ActivityPage> {
    const cursor = query.cursor ? decodeActivityCursor(query.cursor) : undefined;
    if (cursor === null) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Invalid cursor');
    }
    const page = await createRepositories(this.database.client).activity.listForProject(
      project.scope,
      {
        cursor,
        limit: query.limit,
        environmentId: query.environmentId,
      },
    );
    return {
      items: page.items.map((item) => ({
        id: item.id,
        action: item.action,
        outcome: item.outcome,
        occurredAt: item.occurredAt.toISOString(),
        actor: item.actor,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        environmentId: item.environmentId,
        metadata:
          item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
            ? (item.metadata as Record<string, unknown>)
            : {},
      })),
      nextCursor: page.next ? encodeActivityCursor(page.next) : null,
    };
  }

  /* -------------------------------------------------------------- helpers */

  private async createProject(
    principal: Principal,
    workspace: AuthorizedWorkspace,
    request: AuthenticatedRequest,
    input: {
      name: string;
      slug?: string | undefined;
      description?: string | undefined;
      icon: string;
      color: string;
      environments: ReturnType<typeof planEnvironments>;
      audit: { action: string; metadata: Record<string, string> };
    },
  ): Promise<{ id: string; slug: string }> {
    const repos = createRepositories(this.database.client);
    const explicit = input.slug !== undefined;
    for (let attempt = 0; attempt < (explicit ? 1 : SLUG_ATTEMPTS); attempt++) {
      const slug =
        input.slug ??
        uniqueSlug(
          slugify(input.name),
          await repos.projects.usedSlugs(workspace.scope, slugify(input.name)),
        );
      try {
        const created = await withTransaction(this.database.client, async (tx) => {
          const txRepos = createRepositories(tx);
          const project = await txRepos.projects.create(workspace.scope, {
            name: input.name,
            slug,
            description: input.description,
            icon: input.icon,
            color: input.color,
            createdById: principal.userId,
            adminWorkspaceMembershipId: workspace.membership.membershipId,
            environments: input.environments,
          });
          await txRepos.audit.append({
            workspaceId: workspace.scope.workspaceId,
            projectId: project.id,
            actorUserId: principal.userId,
            action: input.audit.action,
            outcome: 'SUCCESS',
            resourceType: 'project',
            resourceId: project.id,
            requestId: requestIdOf(request),
            metadata: {
              ...input.audit.metadata,
              slug,
              environments: input.environments.map((e) => e.slug),
            },
          });
          return { id: project.id, slug };
        });
        return created;
      } catch (error) {
        // A concurrent request took the generated slug: compute a new one.
        if (explicit || attempt === SLUG_ATTEMPTS - 1) mapConstraintError(error);
      }
    }
    throw notFound();
  }

  private async setArchived(
    principal: Principal,
    project: AuthorizedProject,
    request: AuthenticatedRequest,
    archive: boolean,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.projects.setArchived(project.scope, archive))) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          archive ? PROJECT_ERROR_CODES.PROJECT_ARCHIVED : PROJECT_ERROR_CODES.PROJECT_NOT_ARCHIVED,
          archive ? 'The project is already archived' : 'The project is not archived',
        );
      }
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: archive ? 'project.archived' : 'project.restored',
        outcome: 'SUCCESS',
        resourceType: 'project',
        resourceId: project.scope.projectId,
        requestId: requestIdOf(request),
      });
    });
  }
}
