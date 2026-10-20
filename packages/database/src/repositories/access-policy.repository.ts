import type { DbClient } from '../client.js';
import type { EnvironmentScope } from '../scope.js';

export interface EnvironmentGrantRecord {
  id: string;
  workspaceMembershipId: string;
  user: { id: string; email: string; displayName: string | null };
  role: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    permissions: string[];
  };
  effect: 'ALLOW' | 'DENY';
  expiresAt: Date | null;
  createdAt: Date;
}

const grantSelect = {
  id: true,
  workspaceMembershipId: true,
  effect: true,
  expiresAt: true,
  createdAt: true,
  role: {
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      permissions: { select: { permission: { select: { key: true } } } },
    },
  },
  workspaceMembership: {
    select: { user: { select: { id: true, email: true, displayName: true } } },
  },
} as const;

/**
 * Environment-scoped grants (`access_policies`) for workspace members.
 * Service-identity grants arrive with machine credentials in a later phase.
 */
export class AccessPolicyRepository {
  constructor(private readonly db: DbClient) {}

  async list(scope: EnvironmentScope): Promise<EnvironmentGrantRecord[]> {
    const rows = await this.db.accessPolicy.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        workspaceMembershipId: { not: null },
      },
      select: grantSelect,
      orderBy: { createdAt: 'asc' },
    });
    return rows.flatMap(({ workspaceMembership, workspaceMembershipId, role, ...row }) =>
      workspaceMembership && workspaceMembershipId
        ? [
            {
              ...row,
              workspaceMembershipId,
              user: workspaceMembership.user,
              role: { ...role, permissions: role.permissions.map((p) => p.permission.key) },
            },
          ]
        : [],
    );
  }

  async find(scope: EnvironmentScope, grantId: string) {
    return this.db.accessPolicy.findFirst({
      where: {
        id: grantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: {
        id: true,
        workspaceMembershipId: true,
        effect: true,
        role: { select: { key: true } },
      },
    });
  }

  async create(
    scope: EnvironmentScope,
    data: {
      workspaceMembershipId: string;
      roleId: string;
      effect: 'ALLOW' | 'DENY';
      expiresAt: Date | null;
      createdById: string;
    },
  ): Promise<string> {
    const row = await this.db.accessPolicy.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        workspaceMembershipId: data.workspaceMembershipId,
        roleId: data.roleId,
        effect: data.effect,
        expiresAt: data.expiresAt,
        createdById: data.createdById,
      },
      select: { id: true },
    });
    return row.id;
  }

  async remove(scope: EnvironmentScope, grantId: string): Promise<boolean> {
    const result = await this.db.accessPolicy.deleteMany({
      where: {
        id: grantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return result.count === 1;
  }
}
