import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  type ActiveMembership,
  createAuthorizedEnvironmentScope,
  createAuthorizedProjectScope,
  createAuthorizedWorkspaceScope,
  createRepositories,
  type Repositories,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  evaluateEnvironmentPermissions,
  evaluateProjectAccess,
  PROJECT_ERROR_CODES,
  WORKSPACE_ERROR_CODES,
} from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  ALLOW_ARCHIVED_KEY,
  type ArchivableLevel,
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

function archived(code: string, what: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    code,
    `This ${what} is archived. Restore it to make changes.`,
  );
}

function uuidParam(request: AuthenticatedRequest, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw notFound();
  return value;
}

/**
 * Global, default-deny authorization guard (runs after AuthenticationGuard).
 *
 * - Every non-public route must declare a requirement (@Authenticated,
 *   @RequireWorkspacePermission, @RequireProjectPermission or
 *   @RequireEnvironmentPermission). Routes without one are rejected, so a
 *   forgotten decorator fails closed instead of exposing data.
 * - Access is decided from the caller's ACTIVE workspace membership, looked
 *   up by the verified principal. Projects are loaded *inside* the workspace
 *   and environments *inside* the project, so ids from elsewhere are 404.
 * - Not visible → 404 (no existence oracle); visible but not permitted → 403;
 *   archived (and the route did not opt in) → 409.
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
    const allowArchived = new Set(
      this.reflector.getAllAndOverride<ArchivableLevel[] | undefined>(
        ALLOW_ARCHIVED_KEY,
        targets,
      ) ?? [],
    );

    const repos = createRepositories(this.database.client);

    if (requirement.kind !== 'authenticated') {
      const workspaceId = uuidParam(
        request,
        requirement.kind === 'workspace' ? requirement.param : 'workspaceId',
      );
      const membership = await repos.memberships.findActiveMembership(
        workspaceId,
        principal.userId,
      );
      if (!membership) throw notFound();
      if (
        requirement.kind === 'workspace' &&
        !membership.permissions.includes(requirement.permission)
      ) {
        throw forbidden();
      }
      if (membership.workspaceArchived && !allowArchived.has('workspace')) {
        throw archived(WORKSPACE_ERROR_CODES.WORKSPACE_ARCHIVED, 'workspace');
      }
      request.workspace = { scope: createAuthorizedWorkspaceScope(workspaceId), membership };

      if (requirement.kind === 'project' || requirement.kind === 'environment') {
        await this.authorizeProject(request, repos, membership, requirement, allowArchived);
      }
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

  private async authorizeProject(
    request: AuthenticatedRequest,
    repos: Repositories,
    membership: ActiveMembership,
    requirement: Extract<AuthorizationRequirement, { kind: 'project' | 'environment' }>,
    allowArchived: Set<ArchivableLevel>,
  ): Promise<void> {
    const workspaceId = membership.workspaceId;
    const projectId = uuidParam(request, 'projectId');
    const context = await repos.access.loadProject(workspaceId, projectId, membership.membershipId);
    if (!context) throw notFound();
    const access = evaluateProjectAccess({
      workspacePermissions: membership.permissions,
      projectRolePermissions: context.projectRole?.permissions ?? null,
    });
    if (!access.hasAccess || access.source === 'none') throw notFound();
    if (requirement.kind === 'project' && !access.permissions.has(requirement.permission)) {
      throw forbidden();
    }
    const projectArchived = context.project.status === 'ARCHIVED';
    if (projectArchived && !allowArchived.has('project')) {
      throw archived(PROJECT_ERROR_CODES.PROJECT_ARCHIVED, 'project');
    }
    request.project = {
      scope: createAuthorizedProjectScope(workspaceId, projectId),
      permissions: access.permissions,
      access: {
        source: access.source,
        role: context.projectRole
          ? { key: context.projectRole.key, name: context.projectRole.name }
          : null,
      },
      archived: projectArchived,
    };

    if (requirement.kind !== 'environment') return;

    const environmentId = uuidParam(request, 'environmentId');
    const envContext = await repos.access.loadEnvironment(
      workspaceId,
      projectId,
      environmentId,
      membership.membershipId,
    );
    if (!envContext) throw notFound();
    const permissions = evaluateEnvironmentPermissions({
      projectPermissions: access.permissions,
      isProtected: envContext.environment.isProtected,
      grants: envContext.grants,
    });
    // Environments the caller may not even read are indistinguishable from missing.
    if (!permissions.has('environment:read')) throw notFound();
    if (!permissions.has(requirement.permission)) throw forbidden();
    const environmentArchived = envContext.environment.status === 'ARCHIVED';
    if (environmentArchived && !allowArchived.has('environment')) {
      throw archived(PROJECT_ERROR_CODES.ENVIRONMENT_ARCHIVED, 'environment');
    }
    request.environment = {
      scope: createAuthorizedEnvironmentScope(workspaceId, projectId, environmentId),
      permissions,
      isProtected: envContext.environment.isProtected,
      archived: environmentArchived,
    };
  }
}
