import type { DbClient } from '../client.js';
import type { EnvironmentStatus, ProjectStatus } from '../generated/prisma/enums.js';

export interface ProjectAccessContext {
  project: { id: string; workspaceId: string; status: ProjectStatus };
  /** The caller's project role, or null without an explicit project membership. */
  projectRole: { id: string; key: string; name: string; permissions: string[] } | null;
}

export interface EnvironmentAccessContext {
  environment: {
    id: string;
    projectId: string;
    workspaceId: string;
    isProtected: boolean;
    status: EnvironmentStatus;
  };
  grants: { effect: 'ALLOW' | 'DENY'; expiresAt: Date | null; permissions: string[] }[];
}

const rolePermissionsSelect = {
  id: true,
  key: true,
  name: true,
  permissions: { select: { permission: { select: { key: true } } } },
} as const;

/**
 * Authorization lookups used by the API guard. Each loads the child *within*
 * its parent (environment within project within workspace) in one query, so a
 * mismatched id pair is simply "not found". Raw ids are accepted here because
 * establishing access is this repository's job.
 */
export class AccessRepository {
  constructor(private readonly db: DbClient) {}

  async loadProject(
    workspaceId: string,
    projectId: string,
    workspaceMembershipId: string,
  ): Promise<ProjectAccessContext | null> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        memberships: {
          where: { workspaceMembershipId },
          select: { role: { select: rolePermissionsSelect } },
          take: 1,
        },
      },
    });
    if (!project) return null;
    const role = project.memberships[0]?.role;
    return {
      project: { id: project.id, workspaceId: project.workspaceId, status: project.status },
      projectRole: role
        ? {
            id: role.id,
            key: role.key,
            name: role.name,
            permissions: role.permissions.map((p) => p.permission.key),
          }
        : null,
    };
  }

  async loadEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    workspaceMembershipId: string,
  ): Promise<EnvironmentAccessContext | null> {
    const environment = await this.db.environment.findFirst({
      where: { id: environmentId, projectId, workspaceId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        workspaceId: true,
        isProtected: true,
        status: true,
        accessPolicies: {
          where: { workspaceMembershipId },
          select: {
            effect: true,
            expiresAt: true,
            role: {
              select: { permissions: { select: { permission: { select: { key: true } } } } },
            },
          },
        },
      },
    });
    if (!environment) return null;
    const { accessPolicies, ...rest } = environment;
    return {
      environment: rest,
      grants: accessPolicies.map((policy) => ({
        effect: policy.effect,
        expiresAt: policy.expiresAt,
        permissions: policy.role.permissions.map((p) => p.permission.key),
      })),
    };
  }
}
