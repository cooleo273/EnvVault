import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  slugify,
  withTransaction,
} from '@envvault/database';
import {
  createWorkspaceInputSchema,
  type TransferOwnershipInput,
  transferOwnershipInputSchema,
  type UpdateWorkspaceInput,
  updateWorkspaceInputSchema,
  WORKSPACE_ERROR_CODES,
  type WorkspaceDetail,
  type WorkspaceRole,
  type WorkspaceSummary,
} from '@envvault/shared';
import { z } from 'zod';
import {
  AllowArchivedWorkspace,
  Authenticated,
  CurrentPrincipal,
  CurrentWorkspace,
  RequireStepUp,
  RequireWorkspacePermission,
  AllowCliToken,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { DatabaseService } from '../database/database.service.js';
import { toWorkspaceSummary } from './workspace.dto.js';

const SLUG_CONSTRAINT = 'workspaces_slug_live_key';
const GENERATED_SLUG_ATTEMPTS = 5;

const listQuerySchema = z.object({
  archived: z.enum(['exclude', 'include']).default('exclude'),
});

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

@Controller({ path: 'workspaces', version: '1' })
export class WorkspacesController {
  constructor(private readonly database: DatabaseService) {}

  /** Workspaces the caller belongs to (derived from the token, never from input). */
  @Get()
  @AllowCliToken()
  @Authenticated()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<WorkspaceSummary[]> {
    const workspaces = await createRepositories(this.database.client).workspaces.listForUser(
      principal.userId,
      { includeArchived: query.archived === 'include' },
    );
    return workspaces.map(toWorkspaceSummary);
  }

  /**
   * Creates a workspace owned by the caller. Without a slug, one is generated
   * from the name (with a random suffix on collision); an explicit slug that
   * is taken returns 409 SLUG_TAKEN.
   */
  @Post()
  @Authenticated()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createWorkspaceInputSchema))
    body: z.output<typeof createWorkspaceInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkspaceSummary> {
    const explicit = body.slug !== undefined;
    const base = body.slug ?? slugify(body.name);
    for (let attempt = 0; attempt < (explicit ? 1 : GENERATED_SLUG_ATTEMPTS); attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 56)}-${randomBytes(3).toString('hex')}`;
      try {
        const created = await withTransaction(this.database.client, async (tx) => {
          const repos = createRepositories(tx);
          const workspace = await repos.workspaces.createWithOwner({
            name: body.name,
            slug,
            description: body.description,
            type: body.type,
            ownerUserId: principal.userId,
          });
          await repos.users.setLastWorkspace(principal.userId, workspace.id);
          await repos.audit.append({
            workspaceId: workspace.id,
            actorUserId: principal.userId,
            action: 'workspace.created',
            outcome: 'SUCCESS',
            resourceType: 'workspace',
            resourceId: workspace.id,
            requestId: requestIdOf(request),
            metadata: { slug: workspace.slug, type: workspace.type },
          });
          return workspace;
        });
        return toWorkspaceSummary(created);
      } catch (error) {
        if (getConstraintViolation(error)?.constraint !== SLUG_CONSTRAINT) throw error;
      }
    }
    throw new ApiException(
      HttpStatus.CONFLICT,
      WORKSPACE_ERROR_CODES.SLUG_TAKEN,
      'That workspace URL is already taken',
    );
  }

  @Get(':workspaceId')
  @AllowCliToken()
  @RequireWorkspacePermission('workspace:read')
  @AllowArchivedWorkspace()
  async get(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<WorkspaceDetail> {
    const detail = await createRepositories(this.database.client).workspaces.getDetail(
      workspace.scope,
    );
    if (!detail) throw notFound();
    return {
      id: detail.id,
      name: detail.name,
      slug: detail.slug,
      description: detail.description,
      type: detail.type,
      archivedAt: detail.archivedAt?.toISOString() ?? null,
      role: { key: workspace.membership.role.key, name: workspace.membership.role.name },
      createdAt: detail.createdAt.toISOString(),
      updatedAt: detail.updatedAt.toISOString(),
      projectCount: detail.projectCount,
      memberCount: detail.memberCount,
      permissions: workspace.membership.permissions,
    };
  }

  /** Renames or re-describes the workspace. The slug is immutable. */
  @Patch(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:update')
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(updateWorkspaceInputSchema)) body: UpdateWorkspaceInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const updated = await repos.workspaces.update(workspace.scope, body);
      if (!updated) throw notFound();
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'workspace.updated',
        outcome: 'SUCCESS',
        resourceType: 'workspace',
        resourceId: workspace.scope.workspaceId,
        requestId: requestIdOf(request),
        metadata: {
          fields: Object.keys(body).filter((key) => key === 'name' || key === 'description'),
        },
      });
    });
  }

  /** Makes the workspace read-only (owners only). */
  @Post(':workspaceId/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:archive')
  async archive(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, workspace, request, true);
  }

  @Post(':workspaceId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:archive')
  @AllowArchivedWorkspace()
  async restore(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.setArchived(principal, workspace, request, false);
  }

  /** Sensitive: requires `workspace:delete` AND a recent step-up. Soft delete. */
  @Delete(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:delete')
  @AllowArchivedWorkspace()
  @RequireStepUp()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const deleted = await repos.workspaces.softDelete(workspace.scope);
      if (!deleted) throw notFound();
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'workspace.deleted',
        outcome: 'SUCCESS',
        resourceType: 'workspace',
        resourceId: workspace.scope.workspaceId,
        requestId: requestIdOf(request),
      });
    });
  }

  /** Workspace roles that can be assigned to members. */
  @Get(':workspaceId/roles')
  @RequireWorkspacePermission('member:read')
  @AllowArchivedWorkspace()
  async roles(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<WorkspaceRole[]> {
    const roles = await createRepositories(this.database.client).roles.listWorkspaceRoles(
      workspace.scope,
    );
    return roles.map(({ key, name, description }) => ({ key, name, description }));
  }

  /**
   * Sensitive: hands the owner role to another member and makes the caller
   * an admin. Requires `workspace:transfer` and a recent step-up.
   */
  @Post(':workspaceId/transfer-ownership')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:transfer')
  @RequireStepUp()
  async transferOwnership(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(transferOwnershipInputSchema)) body: TransferOwnershipInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const { scope, membership } = workspace;
    if (body.membershipId === membership.membershipId) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        WORKSPACE_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE,
        'Choose another member to transfer ownership to',
      );
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await repos.workspaces.lockForUpdate(scope);
      const target = await repos.memberships.findMember(scope, body.membershipId);
      if (!target) throw notFound();
      const [owner, admin] = await Promise.all([
        repos.roles.findWorkspaceRole(scope, 'owner'),
        repos.roles.findWorkspaceRole(scope, 'admin'),
      ]);
      if (!owner || !admin) throw new Error('Built-in workspace roles are missing');
      await repos.memberships.setRole(scope, target.id, owner.id);
      await repos.memberships.setRole(scope, membership.membershipId, admin.id);
      await repos.audit.append({
        workspaceId: scope.workspaceId,
        actorUserId: principal.userId,
        action: 'workspace.ownership_transferred',
        outcome: 'SUCCESS',
        resourceType: 'workspace_membership',
        resourceId: target.id,
        requestId: requestIdOf(request),
        metadata: { fromMembershipId: membership.membershipId, toMembershipId: target.id },
      });
    });
  }

  /** Leaves the workspace. The last owner must transfer ownership first. */
  @Post(':workspaceId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:read')
  @AllowArchivedWorkspace()
  async leave(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const { scope, membership } = workspace;
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await repos.workspaces.lockForUpdate(scope);
      if (
        membership.role.key === 'owner' &&
        (await repos.memberships.countActiveOwners(scope)) <= 1
      ) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          WORKSPACE_ERROR_CODES.LAST_OWNER,
          'Transfer ownership before leaving: a workspace needs an owner',
        );
      }
      await repos.memberships.remove(scope, membership.membershipId);
      await repos.audit.append({
        workspaceId: scope.workspaceId,
        actorUserId: principal.userId,
        action: 'member.left',
        outcome: 'SUCCESS',
        resourceType: 'workspace_membership',
        resourceId: membership.membershipId,
        requestId: requestIdOf(request),
      });
    });
  }

  private async setArchived(
    principal: Principal,
    workspace: AuthorizedWorkspace,
    request: AuthenticatedRequest,
    archived: boolean,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const changed = archived
        ? await repos.workspaces.archive(workspace.scope)
        : await repos.workspaces.restore(workspace.scope);
      if (!changed) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          archived
            ? WORKSPACE_ERROR_CODES.WORKSPACE_ARCHIVED
            : WORKSPACE_ERROR_CODES.WORKSPACE_NOT_ARCHIVED,
          archived ? 'The workspace is already archived' : 'The workspace is not archived',
        );
      }
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: archived ? 'workspace.archived' : 'workspace.restored',
        outcome: 'SUCCESS',
        resourceType: 'workspace',
        resourceId: workspace.scope.workspaceId,
        requestId: requestIdOf(request),
      });
    });
  }
}
