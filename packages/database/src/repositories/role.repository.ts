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
}
