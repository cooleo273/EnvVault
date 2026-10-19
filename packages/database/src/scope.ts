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
