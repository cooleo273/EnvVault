declare const workspaceScopeBrand: unique symbol;

/**
 * Proof that the current principal has been authorized for a workspace.
 *
 * A workspace ID taken from a URL, token or request body is NOT proof of
 * authorization. Tenant-scoped repositories accept this branded type instead
 * of a raw string, so the only way to obtain one is through the API's
 * authorization layer, which must verify membership/permissions first.
 */
export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly [workspaceScopeBrand]: true;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates a {@link WorkspaceScope}. Call this ONLY from the authorization layer
 * after the principal's access to `workspaceId` has been verified (or from
 * trusted system code such as seeds and migrations).
 */
export function createAuthorizedWorkspaceScope(workspaceId: string): WorkspaceScope {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error('Invalid workspace id');
  }
  return Object.freeze({ workspaceId }) as WorkspaceScope;
}

declare const projectScopeBrand: unique symbol;
declare const environmentScopeBrand: unique symbol;

/**
 * Proof that the principal was authorized for a project inside a workspace.
 * Created only by the API's authorization layer after it loaded the project
 * *within* the workspace, so the pair can never be mismatched (no IDOR).
 */
export interface ProjectScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly [projectScopeBrand]: true;
}

/** Proof of authorization for an environment within its project and workspace. */
export interface EnvironmentScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly [environmentScopeBrand]: true;
}

export function createAuthorizedProjectScope(workspaceId: string, projectId: string): ProjectScope {
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(projectId)) {
    throw new Error('Invalid project scope');
  }
  return Object.freeze({ workspaceId, projectId }) as ProjectScope;
}

export function createAuthorizedEnvironmentScope(
  workspaceId: string,
  projectId: string,
  environmentId: string,
): EnvironmentScope {
  if (![workspaceId, projectId, environmentId].every((id) => UUID_PATTERN.test(id))) {
    throw new Error('Invalid environment scope');
  }
  return Object.freeze({ workspaceId, projectId, environmentId }) as EnvironmentScope;
}

/** The workspace part of a narrower scope (for workspace-level repositories). */
export function workspaceScopeOf(scope: ProjectScope | EnvironmentScope): WorkspaceScope {
  return createAuthorizedWorkspaceScope(scope.workspaceId);
}
