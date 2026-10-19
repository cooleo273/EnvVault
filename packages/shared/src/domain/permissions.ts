/**
 * Permission catalog shared by the API (authorization), the database (catalog
 * sync) and the web app (display). Keys are `resource:action`.
 *
 * Note the deliberate split between `secret:list` (see keys and metadata) and
 * `secret:read` (decrypt values): listing a project's variables must never
 * imply the ability to read their values.
 */
export const PERMISSIONS = {
  'workspace:read': 'View workspace details',
  'workspace:update': 'Update workspace settings',
  'workspace:archive': 'Archive and restore the workspace',
  'workspace:delete': 'Delete the workspace',
  'workspace:transfer': 'Transfer workspace ownership',
  'member:read': 'View workspace members',
  'member:invite': 'Invite new members',
  'member:manage': 'Change member roles and remove members',
  'role:manage': 'Create and edit custom roles',
  'project:read': 'View projects',
  'project:create': 'Create projects',
  'project:update': 'Update project settings and project members',
  'project:delete': 'Delete projects',
  'environment:read': 'View environments',
  'environment:create': 'Create environments',
  'environment:update': 'Update environment settings and protection',
  'environment:delete': 'Delete environments',
  'secret:list': 'List secret keys and metadata (not values)',
  'secret:read': 'Decrypt and read secret values',
  'secret:write': 'Create and update secret values',
  'secret:delete': 'Delete secrets',
  'secret:rollback': 'Restore a previous secret version',
  'service_identity:read': 'View machine identities',
  'service_identity:manage': 'Create, disable and delete machine identities and their credentials',
  'access_policy:manage': 'Grant and revoke environment-scoped access',
  'change_request:create': 'Propose changes to protected environments',
  'change_request:review': 'Approve or reject change requests',
  'change_request:apply': 'Apply approved change requests',
  'audit:read': 'View the audit log',
  'integration:read': 'View integrations',
  'integration:manage': 'Configure integrations and sync jobs',
  'rotation_policy:manage': 'Configure secret rotation policies',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/**
 * Permissions that expose secret values or can cause irreversible or
 * privilege-escalating changes. UIs highlight these when they are granted.
 */
export const SENSITIVE_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'workspace:delete',
  'workspace:transfer',
  'member:manage',
  'role:manage',
  'project:delete',
  'environment:delete',
  'secret:read',
  'secret:write',
  'secret:delete',
  'secret:rollback',
  'service_identity:manage',
  'access_policy:manage',
  'change_request:apply',
  'integration:manage',
]);

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.hasOwn(PERMISSIONS, value);
}

export function isSensitivePermission(key: PermissionKey): boolean {
  return SENSITIVE_PERMISSIONS.has(key);
}
