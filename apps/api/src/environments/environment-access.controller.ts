import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { createRepositories, withTransaction, workspaceScopeOf } from '@envvault/database';
import {
  createEnvironmentGrantInputSchema,
  type EnvironmentAccess,
  evaluateProjectAccess,
  PROJECT_ERROR_CODES,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentEnvironment,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireEnvironmentPermission,
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
import { UuidParam } from '../common/uuid-param.js';
import { DatabaseService } from '../database/database.service.js';
import {
  cannotChangeOwnAccess,
  notFound,
  protectionRequired,
} from '../projects/project.helpers.js';

/**
 * Environment-scoped access grants (ALLOW or DENY of an environment role, with
 * optional expiry). Grants can only target people who already have access to
 * the project, nobody grants to themselves, and any grant on a protected
 * environment needs `environment:protect`.
 */
@Controller({
  path: 'workspaces/:workspaceId/projects/:projectId/environments/:environmentId/access',
  version: '1',
})
export class EnvironmentAccessController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @RequireEnvironmentPermission('access_policy:manage')
  @AllowArchived('workspace', 'project', 'environment')
  async list(
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
  ): Promise<EnvironmentAccess> {
    const repos = createRepositories(this.database.client);
    const [grants, roles] = await Promise.all([
      repos.accessPolicies.list(environment.scope),
      repos.roles.listScopedRoles(workspaceScopeOf(environment.scope), 'ENVIRONMENT'),
    ]);
    return {
      grants: grants.map((g) => ({
        id: g.id,
        workspaceMembershipId: g.workspaceMembershipId,
        user: g.user,
        role: {
          key: g.role.key,
          name: g.role.name,
          description: g.role.description,
          permissions: g.role.permissions.sort(),
        },
        effect: g.effect,
        expiresAt: g.expiresAt?.toISOString() ?? null,
        createdAt: g.createdAt.toISOString(),
        isCurrentUser: g.workspaceMembershipId === workspace.membership.membershipId,
      })),
      roles: roles.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })),
    };
  }

  @Post()
  @RequireEnvironmentPermission('access_policy:manage')
  async grant(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(createEnvironmentGrantInputSchema))
    body: z.output<typeof createEnvironmentGrantInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    if (body.workspaceMembershipId === workspace.membership.membershipId)
      throw cannotChangeOwnAccess();
    if (environment.isProtected && !environment.permissions.has('environment:protect')) {
      throw protectionRequired();
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VALIDATION_FAILED',
        'Expiry must be in the future',
      );
    }
    return withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const target = await repos.projectMembers.findActiveWorkspaceMember(
        project.scope,
        body.workspaceMembershipId,
      );
      if (!target) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          PROJECT_ERROR_CODES.NOT_WORKSPACE_MEMBER,
          'Only active members of this workspace can receive access',
        );
      }
      const projectMembership = await repos.projectMembers.findByWorkspaceMembership(
        project.scope,
        body.workspaceMembershipId,
      );
      const viaWorkspace = evaluateProjectAccess({
        workspacePermissions: target.role.permissions.map((p) => p.permission.key),
        projectRolePermissions: null,
      }).hasAccess;
      if (!projectMembership && !viaWorkspace) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          PROJECT_ERROR_CODES.NOT_PROJECT_MEMBER,
          'Add this person to the project before granting environment access',
        );
      }
      const role = await repos.roles.findScopedRole(
        workspaceScopeOf(environment.scope),
        'ENVIRONMENT',
        body.roleKey,
      );
      if (!role) throw notFound();
      const id = await repos.accessPolicies.create(environment.scope, {
        workspaceMembershipId: body.workspaceMembershipId,
        roleId: role.id,
        effect: body.effect,
        expiresAt,
        createdById: principal.userId,
      });
      await repos.audit.append({
        workspaceId: environment.scope.workspaceId,
        projectId: environment.scope.projectId,
        environmentId: environment.scope.environmentId,
        actorUserId: principal.userId,
        action: 'environment.access_granted',
        outcome: 'SUCCESS',
        resourceType: 'access_policy',
        resourceId: id,
        requestId: requestIdOf(request),
        metadata: {
          role: role.key,
          effect: body.effect,
          userId: target.userId,
          ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        },
      });
      return { id };
    });
  }

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('access_policy:manage')
  @AllowArchived('environment')
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('grantId') grantId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    if (environment.isProtected && !environment.permissions.has('environment:protect')) {
      throw protectionRequired();
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const grant = await repos.accessPolicies.find(environment.scope, grantId);
      if (!grant) throw notFound();
      if (grant.workspaceMembershipId === workspace.membership.membershipId)
        throw cannotChangeOwnAccess();
      await repos.accessPolicies.remove(environment.scope, grantId);
      await repos.audit.append({
        workspaceId: environment.scope.workspaceId,
        projectId: environment.scope.projectId,
        environmentId: environment.scope.environmentId,
        actorUserId: principal.userId,
        action: 'environment.access_revoked',
        outcome: 'SUCCESS',
        resourceType: 'access_policy',
        resourceId: grantId,
        requestId: requestIdOf(request),
        metadata: { role: grant.role.key, effect: grant.effect },
      });
    });
  }
}
