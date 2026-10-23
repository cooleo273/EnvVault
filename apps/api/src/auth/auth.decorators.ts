import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@envvault/shared';
import type {
  AuthenticatedRequest,
  AuthorizedEnvironment,
  AuthorizedProject,
  AuthorizedWorkspace,
  Principal,
} from './principal.js';

export const IS_PUBLIC_KEY = 'envvault:auth:public';
export const ALLOW_UNVERIFIED_EMAIL_KEY = 'envvault:auth:allow-unverified-email';
export const AUTHORIZATION_KEY = 'envvault:auth:authorization';
export const REQUIRE_STEP_UP_KEY = 'envvault:auth:require-step-up';
export const ALLOW_ARCHIVED_KEY = 'envvault:auth:allow-archived';
export const CLI_ACCESS_KEY = 'envvault:auth:cli-access';

export type ArchivableLevel = 'workspace' | 'project' | 'environment';

export type AuthorizationRequirement =
  | { kind: 'authenticated' }
  | { kind: 'workspace'; permission: PermissionKey; param: string }
  | { kind: 'project'; permission: PermissionKey }
  | { kind: 'environment'; permission: PermissionKey };

/** Opts a route out of authentication (health probes). Use sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Accepts CLI access tokens on this route. Routes without it refuse them
 * (CLI_TOKEN_NOT_ALLOWED), so a CLI session can only read what local
 * development needs: identity, workspaces, projects, environments,
 * variable metadata, runtime values and exports.
 */
export const AllowCliToken = () => SetMetadata(CLI_ACCESS_KEY, true);

/** Allows callers whose email is not verified yet (e.g. GET /me, logout). */
export const AllowUnverifiedEmail = () => SetMetadata(ALLOW_UNVERIFIED_EMAIL_KEY, true);

/**
 * Self-service route: any authenticated user may call it; it must only act on
 * the caller's own data (derived from the verified principal, never input).
 */
export const Authenticated = () =>
  SetMetadata(AUTHORIZATION_KEY, { kind: 'authenticated' } satisfies AuthorizationRequirement);

/**
 * Workspace-scoped route: the caller must hold `permission` through an ACTIVE
 * membership of the workspace named by route param `param`. The workspace id
 * in the URL only selects the target; membership is looked up from the
 * verified principal, so the id is never treated as proof of access.
 */
export const RequireWorkspacePermission = (permission: PermissionKey, param = 'workspaceId') =>
  SetMetadata(AUTHORIZATION_KEY, {
    kind: 'workspace',
    permission,
    param,
  } satisfies AuthorizationRequirement);

/**
 * Archived workspaces are read-only: workspace routes are refused with 409
 * WORKSPACE_ARCHIVED unless they opt in here (reads, restore, delete, leave).
 */
export const AllowArchivedWorkspace = () =>
  SetMetadata(ALLOW_ARCHIVED_KEY, ['workspace'] satisfies ArchivableLevel[]);

/**
 * Project-scoped route (`:workspaceId/projects/:projectId`). The project is
 * loaded inside the workspace; access comes from an explicit project role or a
 * workspace role that administers all projects. No access → 404; missing
 * `permission` (evaluated at project level) → 403.
 */
export const RequireProjectPermission = (permission: PermissionKey) =>
  SetMetadata(AUTHORIZATION_KEY, {
    kind: 'project',
    permission,
  } satisfies AuthorizationRequirement);

/**
 * Environment-scoped route (`.../environments/:environmentId`). Effective
 * permissions are evaluated for that environment (protection, grants, DENY).
 * Without `environment:read` the environment is hidden (404).
 */
export const RequireEnvironmentPermission = (permission: PermissionKey) =>
  SetMetadata(AUTHORIZATION_KEY, {
    kind: 'environment',
    permission,
  } satisfies AuthorizationRequirement);

/**
 * Archived workspaces, projects and environments are read-only: routes are
 * refused with 409 unless they opt in for the listed levels.
 */
export const AllowArchived = (...levels: ArchivableLevel[]) =>
  SetMetadata(ALLOW_ARCHIVED_KEY, levels);

/** Sensitive action: requires a recent credential re-verification (step-up). */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP_KEY, true);

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without authentication');
  return principal satisfies Principal;
});

export const CurrentWorkspace = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const workspace = ctx.switchToHttp().getRequest<AuthenticatedRequest>().workspace;
  if (!workspace)
    throw new Error('CurrentWorkspace used on a route without workspace authorization');
  return workspace satisfies AuthorizedWorkspace;
});

export const CurrentProject = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const project = ctx.switchToHttp().getRequest<AuthenticatedRequest>().project;
  if (!project) throw new Error('CurrentProject used on a route without project authorization');
  return project satisfies AuthorizedProject;
});

export const CurrentEnvironment = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const environment = ctx.switchToHttp().getRequest<AuthenticatedRequest>().environment;
  if (!environment) {
    throw new Error('CurrentEnvironment used on a route without environment authorization');
  }
  return environment satisfies AuthorizedEnvironment;
});
