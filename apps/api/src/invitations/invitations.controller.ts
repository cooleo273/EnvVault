import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  createAuthorizedWorkspaceScope,
  createRepositories,
  type ReceivedInvitationRecord,
  withTransaction,
} from '@envvault/database';
import {
  type AcceptedInvitation,
  type CreateInvitationInput,
  createInvitationInputSchema,
  type InvitationTokenInput,
  invitationTokenInputSchema,
  type IssuedInvitation,
  type ReceivedInvitation,
  WORKSPACE_ERROR_CODES,
  type WorkspaceInvitation,
} from '@envvault/shared';
import {
  Authenticated,
  CurrentPrincipal,
  CurrentWorkspace,
  RequireWorkspacePermission,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { SensitiveRateLimit } from '../common/sensitive-rate-limit.js';
import { UuidParam } from '../common/uuid-param.js';
import { DatabaseService } from '../database/database.service.js';
import { toWorkspaceInvitation } from '../workspaces/workspace.dto.js';
import { hashInvitationToken } from './invitation-token.js';
import { InvitationsService } from './invitations.service.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';

function invalidInvitation(): ApiException {
  // One answer for unknown, used, revoked, declined and expired invitations.
  return new ApiException(
    HttpStatus.NOT_FOUND,
    WORKSPACE_ERROR_CODES.INVITATION_INVALID,
    'This invitation is invalid or has expired',
  );
}

function toReceived(invitation: ReceivedInvitationRecord): ReceivedInvitation {
  return {
    id: invitation.id,
    workspace: invitation.workspace,
    role: { key: invitation.role.key, name: invitation.role.name },
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/** Administration of a workspace's invitations. */
@Controller({ path: 'workspaces/:workspaceId/invitations', version: '1' })
export class WorkspaceInvitationsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly invitations: InvitationsService,
  ) {}

  @Get()
  @RequireWorkspacePermission('member:invite')
  async list(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<WorkspaceInvitation[]> {
    const rows = await createRepositories(this.database.client).invitations.listForWorkspace(
      workspace.scope,
    );
    const now = new Date();
    return rows.map((row) => toWorkspaceInvitation(row, now));
  }

  @Post()
  @LimitSensitiveAction('access-change')
  @RequireWorkspacePermission('member:invite')
  @SensitiveRateLimit()
  invite(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(createInvitationInputSchema)) body: CreateInvitationInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<IssuedInvitation> {
    return this.invitations.issue({
      scope: workspace.scope,
      email: body.email,
      roleKey: body.roleKey,
      actorUserId: principal.userId,
      requestId: requestIdOf(request),
    });
  }

  /** Issues a fresh link (new token, new expiry); the previous link stops working. */
  @Post(':invitationId/resend')
  @LimitSensitiveAction('access-change')
  @RequireWorkspacePermission('member:invite')
  @SensitiveRateLimit()
  async resend(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @UuidParam('invitationId') invitationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<IssuedInvitation> {
    const previous = await createRepositories(this.database.client).invitations.findForWorkspace(
      workspace.scope,
      invitationId,
    );
    if (!previous) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    return this.invitations.issue({
      scope: workspace.scope,
      email: previous.email,
      roleKey: previous.role.key,
      actorUserId: principal.userId,
      requestId: requestIdOf(request),
      replaces: previous.id,
    });
  }

  @Delete(':invitationId')
  @LimitSensitiveAction('access-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('member:invite')
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @UuidParam('invitationId') invitationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const existing = await repos.invitations.findForWorkspace(workspace.scope, invitationId);
      if (!existing) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
      if (!(await repos.invitations.revoke(workspace.scope, invitationId))) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          WORKSPACE_ERROR_CODES.INVITATION_INVALID,
          'Only pending invitations can be revoked',
        );
      }
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'invitation.revoked',
        outcome: 'SUCCESS',
        resourceType: 'workspace_invitation',
        resourceId: invitationId,
        requestId: requestIdOf(request),
      });
    });
  }
}

/**
 * The invitee's side. An invitation is usable only by a signed-in user whose
 * verified email (from the Neon Auth token) equals the invited address, and
 * only once. By token (email link) or by id (in-app list of the user's own
 * invitations); the id route is safe because it is bound to that email.
 */
@Controller({ path: 'invitations', version: '1' })
export class InvitationsController {
  constructor(private readonly database: DatabaseService) {}

  /** Pending invitations addressed to the caller. */
  @Get()
  @Authenticated()
  async mine(@CurrentPrincipal() principal: Principal): Promise<ReceivedInvitation[]> {
    const rows = await createRepositories(this.database.client).invitations.listUsableForEmail(
      principal.email.toLowerCase(),
    );
    return rows.map(toReceived);
  }

  /** What a link invites the caller to. Does not consume the invitation. */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @SensitiveRateLimit()
  async lookup(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(invitationTokenInputSchema)) body: InvitationTokenInput,
  ): Promise<ReceivedInvitation> {
    const invitation = await createRepositories(
      this.database.client,
    ).invitations.findUsableByTokenHash(hashInvitationToken(body.token));
    return toReceived(this.forCaller(invitation, principal));
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @SensitiveRateLimit()
  async acceptByToken(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(invitationTokenInputSchema)) body: InvitationTokenInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<AcceptedInvitation> {
    const invitation = await createRepositories(
      this.database.client,
    ).invitations.findUsableByTokenHash(hashInvitationToken(body.token));
    return this.accept(this.forCaller(invitation, principal), principal, request);
  }

  @Post('decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @SensitiveRateLimit()
  async declineByToken(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(invitationTokenInputSchema)) body: InvitationTokenInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const invitation = await createRepositories(
      this.database.client,
    ).invitations.findUsableByTokenHash(hashInvitationToken(body.token));
    await this.decline(this.forCaller(invitation, principal), principal, request);
  }

  @Post(':invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  async acceptById(
    @CurrentPrincipal() principal: Principal,
    @UuidParam('invitationId') invitationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AcceptedInvitation> {
    const invitation = await createRepositories(
      this.database.client,
    ).invitations.findUsableForEmail(invitationId, principal.email.toLowerCase());
    if (!invitation) throw invalidInvitation();
    return this.accept(invitation, principal, request);
  }

  @Post(':invitationId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  async declineById(
    @CurrentPrincipal() principal: Principal,
    @UuidParam('invitationId') invitationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const invitation = await createRepositories(
      this.database.client,
    ).invitations.findUsableForEmail(invitationId, principal.email.toLowerCase());
    if (!invitation) throw invalidInvitation();
    await this.decline(invitation, principal, request);
  }

  /** The invitation, if it is addressed to the caller. Reveals nothing otherwise. */
  private forCaller(
    invitation: ReceivedInvitationRecord | null,
    principal: Principal,
  ): ReceivedInvitationRecord {
    if (!invitation) throw invalidInvitation();
    if (invitation.email !== principal.email.toLowerCase()) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        WORKSPACE_ERROR_CODES.INVITATION_EMAIL_MISMATCH,
        'This invitation was sent to a different email address. Sign in with that address to accept it.',
      );
    }
    return invitation;
  }

  private async accept(
    invitation: ReceivedInvitationRecord,
    principal: Principal,
    request: AuthenticatedRequest,
  ): Promise<AcceptedInvitation> {
    return withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      // The invitation names the workspace; the token/email check in
      // forCaller (or the email-bound lookup) is what authorizes joining it.
      const workspaceScope = createAuthorizedWorkspaceScope(invitation.workspaceId);
      await repos.workspaces.lockForUpdate(workspaceScope);
      if (await repos.memberships.isMember(workspaceScope, principal.userId)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          WORKSPACE_ERROR_CODES.ALREADY_MEMBER,
          'You are already a member of this workspace',
        );
      }
      // Single use: only one concurrent request can move it out of PENDING.
      if (!(await repos.invitations.markAccepted(invitation.id, principal.userId))) {
        throw invalidInvitation();
      }
      const membershipId = await repos.memberships.add(
        workspaceScope,
        principal.userId,
        invitation.role.id,
      );
      await repos.users.setLastWorkspace(principal.userId, invitation.workspaceId);
      await repos.audit.append({
        workspaceId: invitation.workspaceId,
        actorUserId: principal.userId,
        action: 'invitation.accepted',
        outcome: 'SUCCESS',
        resourceType: 'workspace_invitation',
        resourceId: invitation.id,
        requestId: requestIdOf(request),
        metadata: { membershipId, role: invitation.role.key },
      });
      return { workspaceId: invitation.workspaceId };
    });
  }

  private async decline(
    invitation: ReceivedInvitationRecord,
    principal: Principal,
    request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.invitations.markDeclined(invitation.id))) throw invalidInvitation();
      await repos.audit.append({
        workspaceId: invitation.workspaceId,
        actorUserId: principal.userId,
        action: 'invitation.declined',
        outcome: 'SUCCESS',
        resourceType: 'workspace_invitation',
        resourceId: invitation.id,
        requestId: requestIdOf(request),
      });
    });
  }
}
