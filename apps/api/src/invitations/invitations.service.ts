import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  type InvitationRecord,
  type Repositories,
  type WorkspaceScope,
  withTransaction,
} from '@envvault/database';
import { type IssuedInvitation, WORKSPACE_ERROR_CODES } from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { APP_ENV } from '../config/config.module.js';
import { appBaseUrl, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MAILER, type Mailer } from '../notifications/mailer.js';
import { toWorkspaceInvitation } from '../workspaces/workspace.dto.js';
import { generateInvitationToken, invitationUrl } from './invitation-token.js';

const PENDING_EMAIL_CONSTRAINT = 'workspace_invitations_pending_email_key';

interface IssueInput {
  scope: WorkspaceScope;
  email: string;
  roleKey: string;
  actorUserId: string;
  requestId: string | null;
  /** Set when re-issuing: the invitation being replaced. */
  replaces?: string;
}

/**
 * Issues invitations: creates a single-use token (only its hash is stored),
 * records the audit event, then attempts delivery. Delivery runs after the
 * transaction commits and never fails the request; its outcome is reported
 * honestly (`not_configured` when no provider exists).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async issue(input: IssueInput): Promise<IssuedInvitation> {
    const { token, hash } = generateInvitationToken();
    const expiresAt = new Date(Date.now() + this.env.INVITATION_TTL_HOURS * 3_600_000);

    let created: {
      invitation: InvitationRecord;
      workspaceName: string;
      inviterName: string | null;
    };
    try {
      created = await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        await repos.workspaces.lockForUpdate(input.scope);
        if (input.replaces !== undefined) {
          await this.retire(repos, input.scope, input.replaces);
        }
        await this.assertInvitable(repos, input.scope, input.email);
        const role = await repos.roles.findWorkspaceRole(input.scope, input.roleKey);
        if (!role) {
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'VALIDATION_FAILED',
            'Unknown role',
          );
        }
        const invitation = await repos.invitations.create(input.scope, {
          email: input.email,
          roleId: role.id,
          tokenHash: hash,
          expiresAt,
          invitedById: input.actorUserId,
        });
        await repos.audit.append({
          workspaceId: input.scope.workspaceId,
          actorUserId: input.actorUserId,
          action: input.replaces === undefined ? 'member.invited' : 'invitation.resent',
          outcome: 'SUCCESS',
          resourceType: 'workspace_invitation',
          resourceId: invitation.id,
          requestId: input.requestId,
          metadata: {
            role: role.key,
            ...(input.replaces === undefined ? {} : { replacesInvitationId: input.replaces }),
          },
        });
        const detail = await repos.workspaces.getDetail(input.scope);
        return {
          invitation,
          workspaceName: detail?.name ?? '',
          inviterName: invitation.invitedBy?.displayName ?? null,
        };
      });
    } catch (error) {
      if (getConstraintViolation(error)?.constraint === PENDING_EMAIL_CONSTRAINT) {
        throw pendingExists();
      }
      throw error;
    }

    const acceptUrl = invitationUrl(appBaseUrl(this.env), token);
    let status: IssuedInvitation['delivery']['status'];
    try {
      status = await this.mailer.sendInvitation({
        to: created.invitation.email,
        workspaceName: created.workspaceName,
        inviterName: created.inviterName,
        roleName: created.invitation.role.name,
        acceptUrl,
        expiresAt,
      });
    } catch {
      // Never log the message: it contains the one-time link.
      this.logger.warn({ invitationId: created.invitation.id }, 'Invitation email delivery failed');
      status = 'failed';
    }
    return {
      invitation: toWorkspaceInvitation(created.invitation),
      delivery: { status },
      // The link is returned (once) only when it was not emailed, so the
      // inviter can share it. It is never stored or logged.
      acceptUrl: status === 'sent' ? null : acceptUrl,
    };
  }

  private async assertInvitable(repos: Repositories, scope: WorkspaceScope, email: string) {
    const existingUsers = await repos.users.findIdsByEmail(email);
    for (const userId of existingUsers) {
      if (await repos.memberships.isMember(scope, userId)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          WORKSPACE_ERROR_CODES.ALREADY_MEMBER,
          'That person is already a member of this workspace',
        );
      }
    }
    await repos.invitations.expireStale(scope, email);
    if (await repos.invitations.hasPending(scope, email)) throw pendingExists();
  }

  /** Re-issue: the old invitation stops working before the new one exists. */
  private async retire(repos: Repositories, scope: WorkspaceScope, invitationId: string) {
    const previous = await repos.invitations.findForWorkspace(scope, invitationId);
    if (!previous || (previous.status !== 'PENDING' && previous.status !== 'EXPIRED')) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        WORKSPACE_ERROR_CODES.INVITATION_INVALID,
        'Only pending or expired invitations can be resent',
      );
    }
    if (previous.status === 'PENDING') await repos.invitations.revoke(scope, invitationId);
  }
}

function pendingExists(): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    WORKSPACE_ERROR_CODES.INVITATION_PENDING,
    'An invitation for that email is already pending. Resend or revoke it instead.',
  );
}
