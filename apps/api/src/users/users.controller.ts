import { Body, Controller, Get, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { createRepositories } from '@envvault/database';
import {
  type MeResponse,
  type SetActiveWorkspaceInput,
  setActiveWorkspaceInputSchema,
} from '@envvault/shared';
import {
  AllowUnverifiedEmail,
  Authenticated,
  CurrentPrincipal,
  AllowCliToken,
} from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { DatabaseService } from '../database/database.service.js';
import { toWorkspaceSummary } from '../workspaces/workspace.dto.js';

/** The caller's own account. Every value is derived from the verified token. */
@Controller({ path: 'users/me', version: '1' })
export class UsersController {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Profile, accessible workspaces and the workspace to open. The remembered
   * workspace is used only while the caller still has access to it; revoked
   * or archived access falls back to the first accessible workspace, or to
   * null (onboarding).
   */
  @Get()
  @AllowCliToken()
  @Authenticated()
  @AllowUnverifiedEmail()
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    const repos = createRepositories(this.database.client);
    // Independent reads run in parallel: each is a network round trip.
    const [account, workspaces, pendingInvitationCount] = await Promise.all([
      repos.users.getAccount(principal.userId),
      repos.workspaces.listForUser(principal.userId),
      principal.emailVerified
        ? repos.invitations.countUsableForEmail(principal.email.toLowerCase())
        : Promise.resolve(0),
    ]);
    if (!account) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    const remembered = workspaces.find((w) => w.id === account.lastWorkspaceId);
    return {
      user: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        emailVerified: account.emailVerified,
        createdAt: account.createdAt.toISOString(),
      },
      workspaces: workspaces.map(toWorkspaceSummary),
      activeWorkspaceId: (remembered ?? workspaces[0])?.id ?? null,
      pendingInvitationCount,
    };
  }

  /** Remembers the selected workspace, if the caller is an active member of it. */
  @Put('active-workspace')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  async setActiveWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(setActiveWorkspaceInputSchema)) body: SetActiveWorkspaceInput,
  ): Promise<void> {
    const repos = createRepositories(this.database.client);
    const membership = await repos.memberships.findActiveMembership(
      body.workspaceId,
      principal.userId,
    );
    if (!membership || membership.workspaceArchived) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    }
    await repos.users.setLastWorkspace(principal.userId, body.workspaceId);
  }
}
