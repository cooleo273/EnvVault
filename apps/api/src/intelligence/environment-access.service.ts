import { Injectable } from '@nestjs/common';
import {
  type ActiveMembership,
  createAuthorizedEnvironmentScope,
  createRepositories,
} from '@envvault/database';
import { evaluateEnvironmentPermissions } from '@envvault/shared';
import type { AuthorizedEnvironment, AuthorizedProject, Principal } from '../auth/principal.js';
import { DatabaseService } from '../database/database.service.js';
import type { SecretRequestContext } from '../secrets/secret-authorization.service.js';

/** The caller as established by the guard for a project scoped route. */
export interface ProjectCaller {
  principal: Principal;
  membership: ActiveMembership;
  project: AuthorizedProject;
  requestId: string | null;
}

/**
 * Authorizes a second environment of the same project for the caller, with
 * exactly the rules of the global guard: loaded inside the project, effective
 * permissions from the project role, protection and the caller's own grants
 * (DENY wins, expired grants ignored), read from the database now. Returns
 * null when the environment is not visible, like a missing one.
 */
@Injectable()
export class EnvironmentAccessService {
  constructor(private readonly database: DatabaseService) {}

  async environment(
    caller: ProjectCaller,
    environmentId: string,
  ): Promise<AuthorizedEnvironment | null> {
    const { workspaceId, projectId } = caller.project.scope;
    const context = await createRepositories(this.database.client).access.loadEnvironment(
      workspaceId,
      projectId,
      environmentId,
      caller.membership.membershipId,
    );
    if (!context) return null;
    const permissions = evaluateEnvironmentPermissions({
      projectPermissions: caller.project.permissions,
      isProtected: context.environment.isProtected,
      grants: context.grants,
    });
    if (!permissions.has('environment:read')) return null;
    return {
      scope: createAuthorizedEnvironmentScope(workspaceId, projectId, context.environment.id),
      permissions,
      isProtected: context.environment.isProtected,
      archived: context.environment.status === 'ARCHIVED',
    };
  }

  context(caller: ProjectCaller, environment: AuthorizedEnvironment): SecretRequestContext {
    return { principal: caller.principal, environment, requestId: caller.requestId };
  }
}
