import type { DbClient } from '../client.js';
import type { WorkspaceScope } from '../scope.js';

export interface WorkspaceRoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

const WORKSPACE_ROLE_ORDER = ['owner', 'admin', 'member', 'viewer'];

/** Roles of one workspace (never another tenant's). */
export class RoleRepository {
  constructor(private readonly db: DbClient) {}

  /** WORKSPACE-scoped roles, most privileged first. */
  async listWorkspaceRoles(scope: WorkspaceScope): Promise<WorkspaceRoleRecord[]> {
    const roles = await this.db.role.findMany({
      where: { workspaceId: scope.workspaceId, scope: 'WORKSPACE' },
      select: { id: true, key: true, name: true, description: true },
    });
    const rank = (key: string) => {
      const index = WORKSPACE_ROLE_ORDER.indexOf(key);
      return index === -1 ? WORKSPACE_ROLE_ORDER.length : index;
    };
    return roles.sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name));
  }

  async findWorkspaceRole(scope: WorkspaceScope, key: string): Promise<WorkspaceRoleRecord | null> {
    return this.db.role.findFirst({
      where: { workspaceId: scope.workspaceId, scope: 'WORKSPACE', key },
      select: { id: true, key: true, name: true, description: true },
    });
  }

  /** PROJECT- or ENVIRONMENT-scoped roles of the workspace, with their permissions. */
  async listScopedRoles(
    scope: WorkspaceScope,
    roleScope: 'PROJECT' | 'ENVIRONMENT',
  ): Promise<ScopedRoleRecord[]> {
    const roles = await this.db.role.findMany({
      where: { workspaceId: scope.workspaceId, scope: roleScope },
      select: scopedSelect,
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    return roles.map(toScoped);
  }

  async findScopedRole(
    scope: WorkspaceScope,
    roleScope: 'PROJECT' | 'ENVIRONMENT',
    key: string,
  ): Promise<ScopedRoleRecord | null> {
    const role = await this.db.role.findFirst({
      where: { workspaceId: scope.workspaceId, scope: roleScope, key },
      select: scopedSelect,
    });
    return role ? toScoped(role) : null;
  }
}

export interface ScopedRoleRecord extends WorkspaceRoleRecord {
  permissions: string[];
}

const scopedSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  permissions: { select: { permission: { select: { key: true } } } },
} as const;

function toScoped(role: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: { permission: { key: string } }[];
}): ScopedRoleRecord {
  return { ...role, permissions: role.permissions.map((p) => p.permission.key).sort() };
}
