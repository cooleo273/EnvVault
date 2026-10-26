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
import { createRepositories, slugify, withTransaction } from '@envvault/database';
import {
  canModifyEnvironment,
  createEnvironmentInputSchema,
  DEFAULT_ENVIRONMENT_COLORS,
  duplicateEnvironmentInputSchema,
  type EnvironmentDetail,
  type EnvironmentSummary,
  evaluateEnvironmentPermissions,
  listEnvironmentsQuerySchema,
  type Paginated,
  PROJECT_ERROR_CODES,
  type ReorderEnvironmentsInput,
  reorderEnvironmentsInputSchema,
  type UpdateEnvironmentInput,
  updateEnvironmentInputSchema,
  updateEnvironmentProtectionInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentEnvironment,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireEnvironmentPermission,
  RequireProjectPermission,
  AllowCliToken,
} from '../auth/auth.decorators.js';
import type {
  AuthenticatedRequest,
  AuthorizedEnvironment,
  AuthorizedProject,
  AuthorizedWorkspace,
  Principal,
} from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { DatabaseService } from '../database/database.service.js';
import {
  assertRecentStepUp,
  environmentNameTaken,
  mapConstraintError,
  notFound,
  protectionRequired,
  toEnvironmentDetail,
  toEnvironmentSummary,
  uniqueSlug,
} from '../projects/project.helpers.js';

/**
 * Environments of a project: any number, any names, stable ids and slugs.
 * Protected environments need `environment:protect` for every change, and
 * removing protection or deleting a protected environment needs step-up.
 */
@Controller({ path: 'workspaces/:workspaceId/projects/:projectId/environments', version: '1' })
export class EnvironmentsController {
  constructor(private readonly database: DatabaseService) {}

  /** Environments the caller may see (effective `environment:read`), in display order. */
  @Get()
  @AllowCliToken()
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async list(
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Query(new ZodValidationPipe(listEnvironmentsQuerySchema))
    query: z.output<typeof listEnvironmentsQuerySchema>,
  ): Promise<Paginated<EnvironmentSummary>> {
    const rows = await createRepositories(this.database.client).environments.listWithGrants(
      project.scope,
      workspace.membership.membershipId,
      { q: query.q, status: query.status, kind: query.kind },
    );
    const visible = rows.filter((row) =>
      evaluateEnvironmentPermissions({
        projectPermissions: project.permissions,
        isProtected: row.isProtected,
        grants: row.grants,
      }).has('environment:read'),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: visible.slice(start, start + query.pageSize).map(toEnvironmentSummary),
      page: query.page,
      pageSize: query.pageSize,
      total: visible.length,
    };
  }

  @Post()
  @RequireProjectPermission('environment:create')
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(createEnvironmentInputSchema))
    body: z.output<typeof createEnvironmentInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; slug: string }> {
    if (body.isProtected && !project.permissions.has('environment:protect'))
      throw protectionRequired();
    try {
      return await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const used = await repos.environments.usedIdentifiers(project.scope);
        if (used.names.has(body.name.trim().toLowerCase())) throw environmentNameTaken(body.name);
        if (body.slug && used.slugs.has(body.slug)) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            PROJECT_ERROR_CODES.ENVIRONMENT_SLUG_TAKEN,
            'An environment with that URL already exists in this project',
          );
        }
        const slug = body.slug ?? uniqueSlug(slugify(body.name), used.slugs);
        const { id } = await repos.environments.create(
          project.scope,
          {
            name: body.name,
            slug,
            kind: body.kind,
            description: body.description ?? null,
            color: body.color ?? DEFAULT_ENVIRONMENT_COLORS[body.kind],
            icon: body.icon ?? null,
            isProtected: body.isProtected,
            expectedKeys: body.expectedKeys,
            sortOrder: await repos.environments.nextSortOrder(project.scope),
          },
          principal.userId,
        );
        await repos.audit.append({
          workspaceId: project.scope.workspaceId,
          projectId: project.scope.projectId,
          environmentId: id,
          actorUserId: principal.userId,
          action: 'environment.created',
          outcome: 'SUCCESS',
          resourceType: 'environment',
          resourceId: id,
          requestId: requestIdOf(request),
          metadata: {
            name: body.name,
            slug,
            kind: body.kind,
            isProtected: body.isProtected,
            ...(body.templateId ? { templateId: body.templateId } : {}),
          },
        });
        return { id, slug };
      });
    } catch (error) {
      mapConstraintError(error);
    }
  }

  /** Sets the display order. All ids must belong to this project. */
  @Put('order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('environment:update')
  async reorder(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(reorderEnvironmentsInputSchema)) body: ReorderEnvironmentsInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.environments.reorder(project.scope, body.environmentIds))) throw notFound();
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: 'environment.reordered',
        outcome: 'SUCCESS',
        resourceType: 'project',
        resourceId: project.scope.projectId,
        requestId: requestIdOf(request),
        metadata: { count: body.environmentIds.length },
      });
    });
  }

  @Get(':environmentId')
  @AllowCliToken()
  @RequireEnvironmentPermission('environment:read')
  @AllowArchived('workspace', 'project', 'environment')
  async get(@CurrentEnvironment() environment: AuthorizedEnvironment): Promise<EnvironmentDetail> {
    const record = await createRepositories(this.database.client).environments.getDetail(
      environment.scope,
    );
    if (!record) throw notFound();
    return toEnvironmentDetail(record, environment.permissions);
  }

  /** Renames or edits metadata. The id and slug never change. */
  @Patch(':environmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('environment:update')
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(updateEnvironmentInputSchema)) body: UpdateEnvironmentInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    if (
      !canModifyEnvironment(environment.permissions, 'environment:update', environment.isProtected)
    ) {
      throw protectionRequired();
    }
    try {
      await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const before = await repos.environments.getDetail(environment.scope);
        if (!before) throw notFound();
        if (!(await repos.environments.update(environment.scope, body))) throw notFound();
        await this.audit(repos, principal, environment, request, 'environment.updated', {
          fields: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined),
          ...(body.name !== undefined && body.name.trim() !== before.name
            ? { renamedFrom: before.name, renamedTo: body.name.trim() }
            : {}),
        });
      });
    } catch (error) {
      mapConstraintError(error);
    }
  }

  /**
   * Protection settings. Requires `environment:protect`; removing protection
   * additionally requires a recent password step-up.
   */
  @Put(':environmentId/protection')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('environment:protect')
  async setProtection(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(updateEnvironmentProtectionInputSchema))
    body: z.output<typeof updateEnvironmentProtectionInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (environment.isProtected && !body.isProtected) {
        await assertRecentStepUp(repos, principal.userId);
      }
      const before = await repos.environments.getDetail(environment.scope);
      if (!before) throw notFound();
      if (
        !(await repos.environments.setProtection(
          environment.scope,
          body.isProtected,
          body.requiredApprovals,
        ))
      ) {
        throw notFound();
      }
      const action =
        before.isProtected === body.isProtected
          ? 'environment.protection_updated'
          : body.isProtected
            ? 'environment.protected'
            : 'environment.unprotected';
      await this.audit(repos, principal, environment, request, action, {
        requiredApprovals: {
          from: before.requiredApprovals,
          to: body.isProtected ? body.requiredApprovals : 0,
        },
      });
    });
  }

  @Post(':environmentId/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('environment:update')
  async archive(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, environment, request, true);
  }

  @Post(':environmentId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('environment:update')
  @AllowArchived('environment')
  async restore(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, environment, request, false);
  }

  /**
   * Soft delete. Protected environments need `environment:protect` and a
   * recent step-up; unauthorized deletion of production is impossible.
   */
  @Delete(':environmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('environment:delete')
  @AllowArchived('environment')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    if (
      !canModifyEnvironment(environment.permissions, 'environment:delete', environment.isProtected)
    ) {
      throw protectionRequired();
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (environment.isProtected) await assertRecentStepUp(repos, principal.userId);
      const before = await repos.environments.getDetail(environment.scope);
      if (!before) throw notFound();
      if (!(await repos.environments.softDelete(environment.scope))) throw notFound();
      await this.audit(repos, principal, environment, request, 'environment.deleted', {
        name: before.name,
        slug: before.slug,
        isProtected: before.isProtected,
      });
    });
  }

  /**
   * New environment in the same project with this one's structure (kind,
   * description, colors, protection, expected key names). Never copies
   * grants or values. Copying a protected environment needs `environment:protect`.
   */
  @Post(':environmentId/duplicate')
  @RequireEnvironmentPermission('environment:read')
  @AllowArchived('environment')
  async duplicate(
    @CurrentPrincipal() principal: Principal,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(duplicateEnvironmentInputSchema))
    body: z.output<typeof duplicateEnvironmentInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; slug: string }> {
    if (!project.permissions.has('environment:create')) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'You cannot create environments');
    }
    if (environment.isProtected && !project.permissions.has('environment:protect'))
      throw protectionRequired();
    try {
      return await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const source = await repos.environments.getDetail(environment.scope);
        if (!source) throw notFound();
        const used = await repos.environments.usedIdentifiers(project.scope);
        if (used.names.has(body.name.trim().toLowerCase())) throw environmentNameTaken(body.name);
        const slug = body.slug ?? uniqueSlug(slugify(body.name), used.slugs);
        const { id } = await repos.environments.create(
          project.scope,
          {
            name: body.name,
            slug,
            kind: source.kind,
            description: source.description,
            color: source.color,
            icon: source.icon,
            isProtected: source.isProtected,
            requiredApprovals: source.requiredApprovals,
            expectedKeys: source.expectedKeys,
            sortOrder: await repos.environments.nextSortOrder(project.scope),
          },
          principal.userId,
        );
        await repos.audit.append({
          workspaceId: project.scope.workspaceId,
          projectId: project.scope.projectId,
          environmentId: id,
          actorUserId: principal.userId,
          action: 'environment.duplicated',
          outcome: 'SUCCESS',
          resourceType: 'environment',
          resourceId: id,
          requestId: requestIdOf(request),
          metadata: { sourceEnvironmentId: environment.scope.environmentId, slug },
        });
        return { id, slug };
      });
    } catch (error) {
      mapConstraintError(error);
    }
  }

  /* -------------------------------------------------------------- helpers */

  private async setArchived(
    principal: Principal,
    environment: AuthorizedEnvironment,
    request: AuthenticatedRequest,
    archive: boolean,
  ): Promise<void> {
    if (
      !canModifyEnvironment(environment.permissions, 'environment:update', environment.isProtected)
    ) {
      throw protectionRequired();
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.environments.setArchived(environment.scope, archive))) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          archive
            ? PROJECT_ERROR_CODES.ENVIRONMENT_ARCHIVED
            : PROJECT_ERROR_CODES.ENVIRONMENT_NOT_ARCHIVED,
          archive ? 'The environment is already archived' : 'The environment is not archived',
        );
      }
      await this.audit(
        repos,
        principal,
        environment,
        request,
        archive ? 'environment.archived' : 'environment.restored',
        {},
      );
    });
  }

  private async audit(
    repos: ReturnType<typeof createRepositories>,
    principal: Principal,
    environment: AuthorizedEnvironment,
    request: AuthenticatedRequest,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: environment.scope.workspaceId,
      projectId: environment.scope.projectId,
      environmentId: environment.scope.environmentId,
      actorUserId: principal.userId,
      action,
      outcome: 'SUCCESS',
      resourceType: 'environment',
      resourceId: environment.scope.environmentId,
      requestId: requestIdOf(request),
      metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, string>,
    });
  }
}
