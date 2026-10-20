import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createRepositories } from '@envvault/database';
import { AUTH_ERROR_CODES, type PermissionKey } from '@envvault/shared';
import type { AuthorizedEnvironment, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';

/** Who is acting, where, and under which request id (for audit correlation). */
export interface SecretRequestContext {
  principal: Principal;
  environment: AuthorizedEnvironment;
  requestId: string | null;
}

/**
 * Capability checks for secret routes, on top of the global guard.
 *
 * The guard already loaded the caller's membership, project role and grants
 * for this environment from the database on this request (so revoked access
 * and expired grants are never honoured) and requires `secret:list` to reach
 * any secret route. The data plane permissions below are checked here so a
 * refusal can be audited. Protected environments never inherit them (see
 * evaluateEnvironmentPermissions): there they come only from explicit grants.
 *
 *   metadata read  secret:list     value read  secret:read
 *   create/update  secret:write    delete      secret:delete
 *   restore        secret:delete
 */
@Injectable()
export class SecretAuthorizationService {
  private readonly logger = new Logger(SecretAuthorizationService.name);

  constructor(private readonly database: DatabaseService) {}

  async require(
    ctx: SecretRequestContext,
    permission: PermissionKey,
    action: string,
    secretId?: string,
  ): Promise<void> {
    if (ctx.environment.permissions.has(permission)) return;
    await this.recordDenial(ctx, action, secretId, { permission });
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      AUTH_ERROR_CODES.FORBIDDEN,
      ctx.environment.isProtected
        ? `This environment is protected. ${permission} must be granted to you on it directly.`
        : 'You do not have permission to perform this action',
    );
  }

  /**
   * Values of protected environments are revealed only after a recent
   * password confirmation (step up), in addition to the permission.
   */
  async requireStepUpIfProtected(ctx: SecretRequestContext, secretId: string): Promise<void> {
    if (!ctx.environment.isProtected) return;
    const expiry = await createRepositories(this.database.client).authState.findActiveStepUpExpiry(
      ctx.principal.userId,
    );
    if (expiry) return;
    await this.recordDenial(ctx, 'secret.revealed', secretId, { reason: 'step_up_required' });
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      AUTH_ERROR_CODES.STEP_UP_REQUIRED,
      'Confirm your password to reveal values in a protected environment',
    );
  }

  private async recordDenial(
    ctx: SecretRequestContext,
    attempted: string,
    secretId: string | undefined,
    metadata: Record<string, string>,
  ): Promise<void> {
    try {
      await createRepositories(this.database.client).audit.append({
        workspaceId: ctx.environment.scope.workspaceId,
        projectId: ctx.environment.scope.projectId,
        environmentId: ctx.environment.scope.environmentId,
        actorUserId: ctx.principal.userId,
        action: 'secret.access_denied',
        outcome: 'DENIED',
        resourceType: 'secret',
        resourceId: secretId ?? null,
        requestId: ctx.requestId,
        metadata: { attempted, ...metadata },
      });
    } catch {
      // The refusal stands even if it cannot be recorded.
      this.logger.error(`Could not record a denied ${attempted} attempt`);
    }
  }
}
