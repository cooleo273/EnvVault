import type { RoleScope } from '../generated/prisma/enums.js';
import type { PermissionKey } from './permissions.js';

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly PermissionKey[];
}

const PROJECT_READ: PermissionKey[] = ['project:read', 'environment:read', 'secret:list'];

/**
 * Workspace-level permissions. Deliberately excludes every project,
 * environment and secret permission: workspace membership never grants
 * access to secrets on its own. Project and environment roles (below) and
 * access policies grant that separately (Phase 2).
 */
const WORKSPACE_ADMIN: PermissionKey[] = [
  'workspace:read',
  'workspace:update',
  'member:read',
  'member:invite',
  'member:manage',
  'audit:read',
];

/**
 * Built-in roles copied into every workspace (`roles.is_system = true`).
 * Workspace roles apply to the workspace itself; project roles to one
 * project; environment roles are granted per environment via access
 * policies. Anything not granted is denied.
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description:
      'Full control of the workspace, including ownership transfer, archiving and deletion.',
    scope: 'WORKSPACE',
    permissions: [
      ...WORKSPACE_ADMIN,
      'role:manage',
      'workspace:archive',
      'workspace:delete',
      'workspace:transfer',
    ],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manages workspace settings, members and invitations. Cannot manage owners.',
    scope: 'WORKSPACE',
    permissions: WORKSPACE_ADMIN,
  },
  {
    key: 'member',
    name: 'Member',
    description: 'Uses the workspace. Project access is granted separately.',
    scope: 'WORKSPACE',
    permissions: ['workspace:read', 'member:read'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to non-secret workspace information.',
    scope: 'WORKSPACE',
    permissions: ['workspace:read', 'member:read'],
  },
  {
    key: 'project-admin',
    name: 'Project admin',
    description: 'Manages the project, its environments, secrets and access.',
    scope: 'PROJECT',
    permissions: [
      ...PROJECT_READ,
      'project:update',
      'environment:create',
      'environment:update',
      'environment:delete',
      'secret:read',
      'secret:write',
      'secret:delete',
      'secret:rollback',
      'service_identity:read',
      'access_policy:manage',
      'change_request:create',
      'change_request:review',
      'change_request:apply',
      'integration:read',
      'rotation_policy:manage',
    ],
  },
  {
    key: 'project-developer',
    name: 'Project developer',
    description: 'Reads and writes secrets in unprotected environments.',
    scope: 'PROJECT',
    permissions: [...PROJECT_READ, 'secret:read', 'secret:write', 'change_request:create'],
  },
  {
    key: 'project-viewer',
    name: 'Project viewer',
    description: 'Sees environments and secret keys, but not values.',
    scope: 'PROJECT',
    permissions: PROJECT_READ,
  },
  {
    key: 'environment-reader',
    name: 'Environment reader',
    description: 'Reads secret values in one environment.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'secret:read'],
  },
  {
    key: 'environment-writer',
    name: 'Environment writer',
    description: 'Reads and writes secret values in one environment.',
    scope: 'ENVIRONMENT',
    permissions: [
      'environment:read',
      'secret:list',
      'secret:read',
      'secret:write',
      'secret:delete',
      'change_request:create',
    ],
  },
  {
    key: 'environment-approver',
    name: 'Environment approver',
    description: 'Reviews change requests for one environment without reading values.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'change_request:review'],
  },
];
