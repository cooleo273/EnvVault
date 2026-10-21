import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRepositories } from '@envvault/database';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { type SensitiveAction, SensitiveRateLimiter } from './sensitive-rate-limiter.js';

const SENSITIVE_ACTION_KEY = 'envvault:rate-limit:action';

/**
 * Route level guard for sensitive actions outside the secret services.
 * Route guards run after the global ones, so the caller is already
 * authenticated and authorized when the limit is counted.
 */
@Injectable()
export class SensitiveActionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: SensitiveRateLimiter,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<SensitiveAction | undefined>(
      SENSITIVE_ACTION_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (!action || !principal) return true;
    await this.limiter.consume({
      userId: principal.userId,
      action,
      onBlocked: () =>
        createRepositories(this.database.client).audit.append({
          workspaceId: request.workspace?.scope.workspaceId ?? null,
          projectId: request.project?.scope.projectId ?? null,
          environmentId: request.environment?.scope.environmentId ?? null,
          actorUserId: principal.userId,
          action: 'security.rate_limited',
          outcome: 'DENIED',
          resourceType: 'user',
          resourceId: principal.userId,
          requestId: typeof request.id === 'string' ? request.id : null,
          metadata: { limitedAction: action },
        }),
    });
    return true;
  }
}

/** Counts the route against the per user limit of `action`. */
export const LimitSensitiveAction = (action: SensitiveAction) =>
  applyDecorators(SetMetadata(SENSITIVE_ACTION_KEY, action), UseGuards(SensitiveActionGuard));
