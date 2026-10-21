import type { Repositories } from '@envvault/database';
import { evaluateEnvironmentPermissions, evaluateProjectAccess } from '@envvault/shared';

/**
 * The caller's environment permissions as stored right now, evaluated by the
 * same policy functions as the request guard. Long mutations call it again
 * inside their write transaction, so access revoked while they decrypted or
 * prepared their changes stops them before anything is written.
 */
export async function currentEnvironmentPermissions(
  repos: Repositories,
  userId: string,
  scope: { workspaceId: string; projectId: string; environmentId: string },
): Promise<ReadonlySet<string>> {
  const membership = await repos.memberships.findActiveMembership(scope.workspaceId, userId);
  if (!membership) return new Set();
  const project = await repos.access.loadProject(
    scope.workspaceId,
    scope.projectId,
    membership.membershipId,
  );
  if (!project) return new Set();
  const access = evaluateProjectAccess({
    workspacePermissions: membership.permissions,
    projectRolePermissions: project.projectRole?.permissions ?? null,
  });
  if (!access.hasAccess || access.source === 'none') return new Set();
  const environment = await repos.access.loadEnvironment(
    scope.workspaceId,
    scope.projectId,
    scope.environmentId,
    membership.membershipId,
  );
  if (!environment) return new Set();
  return evaluateEnvironmentPermissions({
    projectPermissions: access.permissions,
    isProtected: environment.environment.isProtected,
    grants: environment.grants,
  });
}
