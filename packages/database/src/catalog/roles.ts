import type { RoleScope } from '../generated/prisma/enums.js';
import type { PermissionKey } from './permissions.js';

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly PermissionKey[];
}

/**
 * Workspace administration. Never includes `secret:*`, `environment:deploy`
 * or `change_request:*`: a workspace role never reveals or changes secret
 * values, in any project.
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
 * Administration of every project in the workspace (metadata, environments,
 * protection, project membership and environment grants) — still without
 * any secret value permission. See `@envvault/shared` evaluateProjectAccess.
 */
const PROJECT_ADMINISTRATION: PermissionKey[] = [
  'project:create',
  'project:read',
  'project:update',
  'project:archive',
  'project:delete',
  'project_member:read',
  'project_member:manage',
  'environment:create',
  'environment:read',
  'environment:update',
  'environment:delete',
  'environment:protect',
  'access_policy:manage',
];

const PROJECT_READ: PermissionKey[] = [
  'project:read',
  'project_member:read',
  'environment:read',
  'secret:list',
];

/**
 * Built-in roles copied into every workspace (`roles.is_system = true`).
 * Workspace roles apply to the workspace and administer its projects; project
 * roles apply to one project and its environments; environment roles are
 * granted per environment via access policies. Anything not granted is
 * denied, and protected environments never inherit data-plane permissions.
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
      ...PROJECT_ADMINISTRATION,
      'role:manage',
      'workspace:archive',
      'workspace:delete',
      'workspace:transfer',
    ],
  },
  {
    key: 'admin',
    name: 'Admin',
    description:
      'Manages workspace settings, members, invitations and projects. Cannot manage owners or read secrets by default.',
    scope: 'WORKSPACE',
    permissions: [...WORKSPACE_ADMIN, ...PROJECT_ADMINISTRATION],
  },
  {
    key: 'member',
    name: 'Member',
    description:
      'Uses the workspace and can create projects. Project access is granted per project.',
    scope: 'WORKSPACE',
    permissions: ['workspace:read', 'member:read', 'project:create'],
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
    name: 'Project Admin',
    description:
      'Manages the project, its environments, protection and members. Secret access in protected environments still needs an explicit grant.',
    scope: 'PROJECT',
    permissions: [
      ...PROJECT_READ,
      'project:update',
      'project:archive',
      'project:delete',
      'project_member:manage',
      'environment:create',
      'environment:update',
      'environment:delete',
      'environment:protect',
      'access_policy:manage',
      'secret:read',
      'secret:write',
      'secret:delete',
      'secret:rollback',
      'secret:export',
      'service_identity:read',
      'change_request:create',
      'change_request:review',
      'change_request:apply',
      'integration:read',
      'rotation_policy:manage',
    ],
  },
  {
    key: 'project-developer',
    name: 'Developer',
    description: 'Works with secrets in unprotected environments. Cannot change project settings.',
    scope: 'PROJECT',
    permissions: [...PROJECT_READ, 'secret:read', 'secret:write', 'change_request:create'],
  },
  {
    key: 'project-viewer',
    name: 'Viewer',
    description: 'Sees the project, its environments and secret keys, but not values.',
    scope: 'PROJECT',
    permissions: PROJECT_READ,
  },
  {
    key: 'project-deployer',
    name: 'Deployment Operator',
    description:
      'Deploys unprotected environments with machine credentials (future phase); protected ones need a grant.',
    scope: 'PROJECT',
    permissions: [...PROJECT_READ, 'environment:deploy'],
  },
  {
    key: 'environment-viewer',
    name: 'Metadata viewer',
    description: 'Sees this environment’s metadata only.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read'],
  },
  {
    key: 'environment-maintainer',
    name: 'Maintainer',
    description: 'Edits this environment’s metadata.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'environment:update'],
  },
  {
    key: 'environment-deployer',
    name: 'Deployer',
    description: 'Deploys this environment with machine credentials (future phase).',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'environment:deploy'],
  },
  {
    key: 'environment-reader',
    name: 'Secret reader',
    description: 'Reads secret values in this environment.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'secret:read'],
  },
  {
    key: 'environment-writer',
    name: 'Secret writer',
    description: 'Reads, writes, deletes and rolls back secret values in this environment.',
    scope: 'ENVIRONMENT',
    permissions: [
      'environment:read',
      'secret:list',
      'secret:read',
      'secret:write',
      'secret:delete',
      'secret:rollback',
      'change_request:create',
    ],
  },
  {
    key: 'environment-exporter',
    name: 'Secret exporter',
    description:
      'Reads values and downloads them in bulk from this environment. Export is never implied by read access.',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'secret:read', 'secret:export'],
  },
  {
    key: 'environment-approver',
    name: 'Approver',
    description:
      'Reviews change requests for this environment without reading values (future phase).',
    scope: 'ENVIRONMENT',
    permissions: ['environment:read', 'secret:list', 'change_request:review'],
  },
];
