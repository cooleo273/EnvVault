import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createAuthorizedWorkspaceScope, createRepositories } from '@envvault/database';
import { AUTH_ERROR_CODES, WORKSPACE_ERROR_CODES } from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  ALLOW_ARCHIVED_KEY,
  AUTHORIZATION_KEY,
  type AuthorizationRequirement,
  IS_PUBLIC_KEY,
  REQUIRE_STEP_UP_KEY,
} from './auth.decorators.js';
import type { AuthenticatedRequest } from './principal.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forbidden(message = 'You do not have permission to perform this action'): ApiException {
  return new ApiException(HttpStatus.FORBIDDEN, AUTH_ERROR_CODES.FORBIDDEN, message);
}

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

/**
 * Global, default-deny authorization guard (runs after AuthenticationGuard).
 *
 * - Every non-public route must declare a requirement (@Authenticated or
 *   @RequireWorkspacePermission). Routes without one are rejected, so a
 *   forgotten decorator fails closed instead of exposing data.
 * - Workspace access is decided from the caller's ACTIVE membership, looked up
 *   by the verified principal. Non-members get 404 (no existence oracle);
 *   members without the permission get 403.
 * - @RequireStepUp routes additionally need a recent credential re-check.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(AuthorizationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (!principal) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        AUTH_ERROR_CODES.UNAUTHENTICATED,
        'Authentication required',
      );
    }

    const requirement = this.reflector.getAllAndOverride<AuthorizationRequirement | undefined>(
      AUTHORIZATION_KEY,
      targets,
    );
    if (!requirement) {
      this.logger.error(
        { handler: `${context.getClass().name}.${context.getHandler().name}` },
        'Route has no authorization requirement; denying by default',
      );
      throw forbidden();
    }

    const repos = createRepositories(this.database.client);

    if (requirement.kind === 'workspace') {
      const workspaceId = request.params[requirement.param];
      if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
        throw notFound();
      }
      const membership = await repos.memberships.findActiveMembership(
        workspaceId,
        principal.userId,
      );
      if (!membership) {
        throw notFound();
      }
      if (!membership.permissions.includes(requirement.permission)) {
        throw forbidden();
      }
      if (
        membership.workspaceArchived &&
        !this.reflector.getAllAndOverride<boolean>(ALLOW_ARCHIVED_KEY, targets)
      ) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          WORKSPACE_ERROR_CODES.WORKSPACE_ARCHIVED,
          'This workspace is archived. Restore it to make changes.',
        );
      }
      request.workspace = { scope: createAuthorizedWorkspaceScope(workspaceId), membership };
    }

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_STEP_UP_KEY, targets)) {
      const expiry = await repos.authState.findActiveStepUpExpiry(principal.userId);
      if (!expiry) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          AUTH_ERROR_CODES.STEP_UP_REQUIRED,
          'Confirm your password to continue',
        );
      }
    }

    return true;
  }
}
