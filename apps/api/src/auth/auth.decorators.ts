import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@envvault/shared';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from './principal.js';

export const IS_PUBLIC_KEY = 'envvault:auth:public';
export const ALLOW_UNVERIFIED_EMAIL_KEY = 'envvault:auth:allow-unverified-email';
export const AUTHORIZATION_KEY = 'envvault:auth:authorization';
export const REQUIRE_STEP_UP_KEY = 'envvault:auth:require-step-up';
export const ALLOW_ARCHIVED_KEY = 'envvault:auth:allow-archived';

export type AuthorizationRequirement =
  { kind: 'authenticated' } | { kind: 'workspace'; permission: PermissionKey; param: string };

/** Opts a route out of authentication (health probes). Use sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

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
export const AllowArchivedWorkspace = () => SetMetadata(ALLOW_ARCHIVED_KEY, true);

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
