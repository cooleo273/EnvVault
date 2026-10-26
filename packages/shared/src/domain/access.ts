import type { PermissionKey } from './permissions.js';

/**
 * Effective-permission evaluation for projects and environments. Pure and
 * shared: the API uses it to authorize (the only place it is enforced) and
 * the web app uses it only to decide what to show.
 *
 * Hierarchy (default deny):
 *
 *   workspace role ──► project access ──► environment access
 *
 * 1. Project access requires either an explicit project membership or a
 *    workspace role that administers all projects (`project:read`, held by
 *    workspace owners and admins). Workspace roles never carry secret
 *    permissions, so administering a project never reveals its secrets.
 * 2. Project permissions = project-scoped permissions of the workspace role
 *    ∪ permissions of the project role.
 * 3. Environment permissions = inherited environment-scoped project
 *    permissions, MINUS data-plane permissions when the environment is
 *    protected, ∪ ALLOW grants on that environment, MINUS DENY grants.
 *    DENY always wins. Production-style (protected) environments therefore
 *    never inherit secret access: it must be granted explicitly.
 */

/** Permissions that only make sense on a project (or workspace) as a whole. */
export const PROJECT_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'project:read',
  'project:update',
  'project:archive',
  'project:delete',
  'project_member:read',
  'project_member:manage',
  'environment:create',
  'service_identity:read',
  'service_identity:manage',
]);

/** Permissions evaluated per environment. */
export const ENVIRONMENT_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'environment:read',
  'environment:update',
  'environment:delete',
  'environment:protect',
  'environment:deploy',
  'access_policy:manage',
  'secret:list',
  'secret:read',
  'secret:write',
  'secret:delete',
  'secret:rollback',
  'secret:export',
  'secret:runtime',
  'change_request:create',
  'change_request:review',
  'change_request:apply',
]);

/**
 * Data-plane permissions: they touch (future) secret values or deployments.
 * Never inherited into a protected environment.
 */
export const DATA_PLANE_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'secret:read',
  'secret:write',
  'secret:delete',
  'secret:rollback',
  'secret:export',
  'secret:runtime',
  'environment:deploy',
  'change_request:apply',
]);

export interface ProjectAccessInput {
  /** Permissions of the caller's workspace role. */
  workspacePermissions: Iterable<string>;
  /** Permissions of the caller's project role, or null without project membership. */
  projectRolePermissions: Iterable<string> | null;
}

export interface ProjectAccess {
  hasAccess: boolean;
  /** How access was obtained (for display); `none` means no access. */
  source: 'project_member' | 'workspace_role' | 'none';
  permissions: ReadonlySet<string>;
}

export function evaluateProjectAccess(input: ProjectAccessInput): ProjectAccess {
  const workspace = new Set(input.workspacePermissions);
  const viaWorkspace = workspace.has('project:read');
  const isMember = input.projectRolePermissions !== null;
  if (!viaWorkspace && !isMember) {
    return { hasAccess: false, source: 'none', permissions: new Set() };
  }
  const permissions = new Set<string>();
  if (viaWorkspace) {
    for (const key of workspace) {
      if (
        PROJECT_PERMISSIONS.has(key as PermissionKey) ||
        ENVIRONMENT_PERMISSIONS.has(key as PermissionKey)
      ) {
        permissions.add(key);
      }
    }
  }
  for (const key of input.projectRolePermissions ?? []) permissions.add(key);
  return {
    hasAccess: true,
    source: isMember ? 'project_member' : 'workspace_role',
    permissions,
  };
}

export interface GrantInput {
  effect: 'ALLOW' | 'DENY';
  permissions: Iterable<string>;
  /** Grants past their expiry are ignored. */
  expiresAt?: Date | null;
}

export interface EnvironmentAccessInput {
  projectPermissions: ReadonlySet<string> | Iterable<string>;
  isProtected: boolean;
  grants: readonly GrantInput[];
  now?: Date;
}

export function evaluateEnvironmentPermissions(input: EnvironmentAccessInput): Set<string> {
  const now = input.now ?? new Date();
  const result = new Set<string>();
  for (const key of input.projectPermissions) {
    if (!ENVIRONMENT_PERMISSIONS.has(key as PermissionKey)) continue;
    if (input.isProtected && DATA_PLANE_PERMISSIONS.has(key as PermissionKey)) continue;
    result.add(key);
  }
  const active = input.grants.filter((g) => !g.expiresAt || g.expiresAt > now);
  for (const grant of active) {
    if (grant.effect !== 'ALLOW') continue;
    for (const key of grant.permissions) {
      if (ENVIRONMENT_PERMISSIONS.has(key as PermissionKey)) result.add(key);
    }
  }
  for (const grant of active) {
    if (grant.effect !== 'DENY') continue;
    for (const key of grant.permissions) result.delete(key);
  }
  return result;
}

/**
 * Changing a protected environment needs `environment:protect` in addition to
 * the action's own permission (stronger requirement for production).
 */
export function canModifyEnvironment(
  permissions: ReadonlySet<string>,
  action: 'environment:update' | 'environment:delete',
  isProtected: boolean,
): boolean {
  return permissions.has(action) && (!isProtected || permissions.has('environment:protect'));
}

/**
 * Everything a machine identity can ever be allowed: read environment
 * metadata, list variables, load values at runtime. Never write, export,
 * reveal or administer. Credential scopes and machine grants are both
 * confined to this set.
 */
export const MACHINE_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'environment:read',
  'secret:list',
  'secret:runtime',
]);

export interface MachineAccessInput {
  /** The identity's grants on this environment (ALLOW and DENY). */
  grants: readonly GrantInput[];
  /** Scopes of the access token (already a subset of its credential's scopes). */
  scopes: Iterable<string>;
  now?: Date;
}

/**
 * Effective permissions of a machine identity on one environment: its active
 * ALLOW grants minus its active DENY grants, confined to
 * {@link MACHINE_PERMISSIONS} and to the token's scopes. Nothing comes from
 * project roles, workspace roles or the person who created the identity, so
 * protected environments need an explicit grant like any other.
 */
export function evaluateMachinePermissions(input: MachineAccessInput): Set<string> {
  const now = input.now ?? new Date();
  const scopes = new Set(input.scopes);
  const active = input.grants.filter((g) => !g.expiresAt || g.expiresAt > now);
  const result = new Set<string>();
  for (const grant of active) {
    if (grant.effect !== 'ALLOW') continue;
    for (const key of grant.permissions) {
      if (MACHINE_PERMISSIONS.has(key as PermissionKey) && scopes.has(key)) result.add(key);
    }
  }
  for (const grant of active) {
    if (grant.effect !== 'DENY') continue;
    for (const key of grant.permissions) result.delete(key);
  }
  return result;
}

/** Whether every permission of a role may be held by a machine identity. */
export function isMachineGrantable(permissions: Iterable<string>): boolean {
  let any = false;
  for (const key of permissions) {
    if (!MACHINE_PERMISSIONS.has(key as PermissionKey)) return false;
    any = true;
  }
  return any;
}
