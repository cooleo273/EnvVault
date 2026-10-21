import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  withTransaction,
  workspaceScopeOf,
} from '@envvault/database';
import {
  type AddProjectMemberInput,
  addProjectMemberInputSchema,
  PROJECT_ERROR_CODES,
  type ProjectAccessList,
  type ScopedRole,
  type UpdateProjectMemberInput,
  updateProjectMemberInputSchema,
} from '@envvault/shared';
import {
  AllowArchived,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireProjectPermission,
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
import { UuidParam } from '../common/uuid-param.js';
import { DatabaseService } from '../database/database.service.js';
import { cannotChangeOwnAccess, notFound } from './project.helpers.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';

/**
 * Project membership. Members must be ACTIVE members of the same workspace
 * (enforced by a composite foreign key); external identities can only join
 * through a workspace invitation first. Nobody changes their own access.
 */
@Controller({ path: 'workspaces/:workspaceId/projects/:projectId', version: '1' })
export class ProjectMembersController {
  constructor(private readonly database: DatabaseService) {}

  /** Who has access: explicit project members and workspace administrators. */
  @Get('members')
  @RequireProjectPermission('project_member:read')
  @AllowArchived('workspace', 'project')
  async list(
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
  ): Promise<ProjectAccessList> {
    const repos = createRepositories(this.database.client);
    const [members, inherited] = await Promise.all([
      repos.projectMembers.list(project.scope),
      repos.projectMembers.listInherited(project.scope),
    ]);
    const me = workspace.membership.membershipId;
    return {
      members: members.map((m) => ({
        id: m.id,
        workspaceMembershipId: m.workspaceMembershipId,
        user: m.user,
        role: { key: m.role.key, name: m.role.name },
        createdAt: m.createdAt.toISOString(),
        isCurrentUser: m.workspaceMembershipId === me,
      })),
      inherited: inherited.map((i) => ({
        workspaceMembershipId: i.workspaceMembershipId,
        user: i.user,
        workspaceRole: i.workspaceRole,
        isCurrentUser: i.workspaceMembershipId === me,
      })),
    };
  }

  /** Project roles (for members) and environment roles (for grants). */
  @Get('roles')
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  async roles(
    @CurrentProject() project: AuthorizedProject,
  ): Promise<{ projectRoles: ScopedRole[]; environmentRoles: ScopedRole[] }> {
    const repos = createRepositories(this.database.client);
    const scope = workspaceScopeOf(project.scope);
    const [projectRoles, environmentRoles] = await Promise.all([
      repos.roles.listScopedRoles(scope, 'PROJECT'),
      repos.roles.listScopedRoles(scope, 'ENVIRONMENT'),
    ]);
    const map = (r: (typeof projectRoles)[number]) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    });
    return { projectRoles: projectRoles.map(map), environmentRoles: environmentRoles.map(map) };
  }

  @Post('members')
  @LimitSensitiveAction('access-change')
  @RequireProjectPermission('project_member:manage')
  async add(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(addProjectMemberInputSchema)) body: AddProjectMemberInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    if (body.workspaceMembershipId === workspace.membership.membershipId)
      throw cannotChangeOwnAccess();
    try {
      return await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const target = await repos.projectMembers.findActiveWorkspaceMember(
          project.scope,
          body.workspaceMembershipId,
        );
        if (!target) {
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            PROJECT_ERROR_CODES.NOT_WORKSPACE_MEMBER,
            'Only active members of this workspace can be added. Invite them to the workspace first.',
          );
        }
        const role = await repos.roles.findScopedRole(
          workspaceScopeOf(project.scope),
          'PROJECT',
          body.roleKey,
        );
        if (!role) throw notFound();
        const id = await repos.projectMembers.add(
          project.scope,
          body.workspaceMembershipId,
          role.id,
        );
        await repos.audit.append({
          workspaceId: project.scope.workspaceId,
          projectId: project.scope.projectId,
          actorUserId: principal.userId,
          action: 'project.member_added',
          outcome: 'SUCCESS',
          resourceType: 'project_membership',
          resourceId: id,
          requestId: requestIdOf(request),
          metadata: { role: role.key, userId: target.userId },
        });
        return { id };
      });
    } catch (error) {
      if (getConstraintViolation(error)?.kind === 'unique') {
        throw new ApiException(
          HttpStatus.CONFLICT,
          PROJECT_ERROR_CODES.ALREADY_PROJECT_MEMBER,
          'That person is already a member of this project',
        );
      }
      throw error;
    }
  }

  @Patch('members/:memberId')
  @LimitSensitiveAction('access-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project_member:manage')
  async changeRole(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('memberId') memberId: string,
    @Body(new ZodValidationPipe(updateProjectMemberInputSchema)) body: UpdateProjectMemberInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const member = await repos.projectMembers.find(project.scope, memberId);
      if (!member) throw notFound();
      if (member.workspaceMembershipId === workspace.membership.membershipId)
        throw cannotChangeOwnAccess();
      if (member.role.key === body.roleKey) return;
      const role = await repos.roles.findScopedRole(
        workspaceScopeOf(project.scope),
        'PROJECT',
        body.roleKey,
      );
      if (!role) throw notFound();
      await repos.projectMembers.setRole(project.scope, memberId, role.id);
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: 'project.member_role_changed',
        outcome: 'SUCCESS',
        resourceType: 'project_membership',
        resourceId: memberId,
        requestId: requestIdOf(request),
        metadata: { from: member.role.key, to: role.key, userId: member.user.id },
      });
    });
  }

  /** Removes the member and their environment grants in this project. */
  @Delete('members/:memberId')
  @LimitSensitiveAction('access-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('project_member:manage')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('memberId') memberId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const member = await repos.projectMembers.find(project.scope, memberId);
      if (!member) throw notFound();
      if (member.workspaceMembershipId === workspace.membership.membershipId)
        throw cannotChangeOwnAccess();
      await repos.projectMembers.remove(project.scope, memberId);
      const grantsRemoved = await repos.accessPolicies.removeAllForMember(
        project.scope,
        member.workspaceMembershipId,
      );
      await repos.audit.append({
        workspaceId: project.scope.workspaceId,
        projectId: project.scope.projectId,
        actorUserId: principal.userId,
        action: 'project.member_removed',
        outcome: 'SUCCESS',
        resourceType: 'project_membership',
        resourceId: memberId,
        requestId: requestIdOf(request),
        metadata: {
          role: member.role.key,
          userId: member.user.id,
          environmentGrantsRemoved: grantsRemoved,
        },
      });
    });
  }
}
