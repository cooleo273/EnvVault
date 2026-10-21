import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Req } from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  type MemberRecord,
  type Repositories,
  withTransaction,
} from '@envvault/database';
import {
  type UpdateMemberRoleInput,
  updateMemberRoleInputSchema,
  WORKSPACE_ERROR_CODES,
  type WorkspaceMember,
} from '@envvault/shared';
import {
  AllowArchivedWorkspace,
  CurrentPrincipal,
  CurrentWorkspace,
  RequireWorkspacePermission,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { UuidParam } from '../common/uuid-param.js';
import { DatabaseService } from '../database/database.service.js';
import { toWorkspaceMember } from '../workspaces/workspace.dto.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';

const LAST_OWNER_CONSTRAINT = 'workspace_memberships_last_owner';

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

function lastOwner(): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    WORKSPACE_ERROR_CODES.LAST_OWNER,
    'A workspace needs at least one owner',
  );
}

function ownerRequired(): ApiException {
  return new ApiException(
    HttpStatus.FORBIDDEN,
    WORKSPACE_ERROR_CODES.OWNER_REQUIRED,
    'Only owners can change or remove owners',
  );
}

/**
 * Workspace members. Rules, enforced here and (for the last owner) again by
 * a database trigger:
 * - nobody changes their own role (use ownership transfer or leave);
 * - only owners grant the owner role or modify/remove an owner;
 * - the last owner can be neither demoted nor removed.
 */
@Controller({ path: 'workspaces/:workspaceId/members', version: '1' })
export class MembersController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @RequireWorkspacePermission('member:read')
  @AllowArchivedWorkspace()
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
  ): Promise<WorkspaceMember[]> {
    const members = await createRepositories(this.database.client).memberships.listMembers(
      workspace.scope,
    );
    return members.map((m) => toWorkspaceMember(m, principal.userId));
  }

  @Patch(':membershipId')
  @LimitSensitiveAction('access-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('member:manage')
  async changeRole(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @UuidParam('membershipId') membershipId: string,
    @Body(new ZodValidationPipe(updateMemberRoleInputSchema)) body: UpdateMemberRoleInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.mutate(async (repos) => {
      const target = await this.loadTarget(repos, workspace, membershipId);
      if (target.role.key === body.roleKey) return;
      const actorIsOwner = workspace.membership.role.key === 'owner';
      if ((target.role.key === 'owner' || body.roleKey === 'owner') && !actorIsOwner) {
        throw ownerRequired();
      }
      if (
        target.role.key === 'owner' &&
        (await repos.memberships.countActiveOwners(workspace.scope)) <= 1
      ) {
        throw lastOwner();
      }
      const role = await repos.roles.findWorkspaceRole(workspace.scope, body.roleKey);
      if (!role) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'VALIDATION_FAILED',
          'Unknown role',
        );
      }
      await repos.memberships.setRole(workspace.scope, target.id, role.id);
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'member.role_changed',
        outcome: 'SUCCESS',
        resourceType: 'workspace_membership',
        resourceId: target.id,
        requestId: requestIdOf(request),
        metadata: { from: target.role.key, to: role.key },
      });
    });
  }

  @Delete(':membershipId')
  @LimitSensitiveAction('access-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('member:manage')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @UuidParam('membershipId') membershipId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.mutate(async (repos) => {
      const target = await this.loadTarget(repos, workspace, membershipId);
      if (target.role.key === 'owner') {
        if (workspace.membership.role.key !== 'owner') throw ownerRequired();
        if ((await repos.memberships.countActiveOwners(workspace.scope)) <= 1) throw lastOwner();
      }
      await repos.memberships.remove(workspace.scope, target.id);
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'member.removed',
        outcome: 'SUCCESS',
        resourceType: 'workspace_membership',
        resourceId: target.id,
        requestId: requestIdOf(request),
        metadata: { role: target.role.key },
      });
    });
  }

  /** Runs a member change serialised per workspace, mapping the DB last-owner guard. */
  private async mutate(change: (repos: Repositories) => Promise<void>): Promise<void> {
    try {
      await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        await change(repos);
      });
    } catch (error) {
      if (
        getConstraintViolation(error)?.constraint === LAST_OWNER_CONSTRAINT ||
        (error instanceof Error && error.message.includes(LAST_OWNER_CONSTRAINT))
      ) {
        throw lastOwner();
      }
      throw error;
    }
  }

  private async loadTarget(
    repos: Repositories,
    workspace: AuthorizedWorkspace,
    membershipId: string,
  ): Promise<MemberRecord> {
    await repos.workspaces.lockForUpdate(workspace.scope);
    const target = await repos.memberships.findMember(workspace.scope, membershipId);
    if (!target) throw notFound();
    if (target.id === workspace.membership.membershipId) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        WORKSPACE_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE,
        'You cannot change or remove your own membership here. Transfer ownership or leave the workspace instead.',
      );
    }
    return target;
  }
}
