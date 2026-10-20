import type { DbClient } from '../client.js';
import type { ProjectScope } from '../scope.js';

export interface ProjectMemberRecord {
  id: string;
  workspaceMembershipId: string;
  user: { id: string; email: string; displayName: string | null };
  role: { id: string; key: string; name: string };
  createdAt: Date;
}

export interface InheritedAccessRecord {
  workspaceMembershipId: string;
  user: { id: string; email: string; displayName: string | null };
  workspaceRole: { key: string; name: string };
}

const memberSelect = {
  id: true,
  workspaceMembershipId: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
  workspaceMembership: {
    select: { user: { select: { id: true, email: true, displayName: true } } },
  },
} as const;

/**
 * Explicit project memberships. A project member is always an ACTIVE member
 * of the same workspace (composite foreign key), so removing someone from the
 * workspace removes their project access and grants too (cascade).
 */
export class ProjectMemberRepository {
  constructor(private readonly db: DbClient) {}

  async list(scope: ProjectScope): Promise<ProjectMemberRecord[]> {
    const rows = await this.db.projectMembership.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        workspaceMembership: { status: 'ACTIVE', user: { deletedAt: null } },
      },
      select: memberSelect,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ workspaceMembership, ...row }) => ({
      ...row,
      user: workspaceMembership.user,
    }));
  }

  /** Workspace members who administer every project through their workspace role. */
  async listInherited(scope: ProjectScope): Promise<InheritedAccessRecord[]> {
    const rows = await this.db.workspaceMembership.findMany({
      where: {
        workspaceId: scope.workspaceId,
        status: 'ACTIVE',
        user: { deletedAt: null },
        role: { permissions: { some: { permission: { key: 'project:read' } } } },
      },
      select: {
        id: true,
        role: { select: { key: true, name: true } },
        user: { select: { id: true, email: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ workspaceMembershipId: r.id, user: r.user, workspaceRole: r.role }));
  }

  async find(
    scope: ProjectScope,
    projectMembershipId: string,
  ): Promise<ProjectMemberRecord | null> {
    const row = await this.db.projectMembership.findFirst({
      where: {
        id: projectMembershipId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
      select: memberSelect,
    });
    if (!row) return null;
    const { workspaceMembership, ...rest } = row;
    return { ...rest, user: workspaceMembership.user };
  }

  async findByWorkspaceMembership(scope: ProjectScope, workspaceMembershipId: string) {
    return this.db.projectMembership.findFirst({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, workspaceMembershipId },
      select: { id: true },
    });
  }

  /** An ACTIVE membership of this workspace (target of a project grant). */
  async findActiveWorkspaceMember(scope: ProjectScope, workspaceMembershipId: string) {
    return this.db.workspaceMembership.findFirst({
      where: {
        id: workspaceMembershipId,
        workspaceId: scope.workspaceId,
        status: 'ACTIVE',
        user: { deletedAt: null },
      },
      select: {
        id: true,
        userId: true,
        role: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
      },
    });
  }

  async add(scope: ProjectScope, workspaceMembershipId: string, roleId: string): Promise<string> {
    const row = await this.db.projectMembership.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        workspaceMembershipId,
        roleId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async setRole(
    scope: ProjectScope,
    projectMembershipId: string,
    roleId: string,
  ): Promise<boolean> {
    const result = await this.db.projectMembership.updateMany({
      where: {
        id: projectMembershipId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
      data: { roleId },
    });
    return result.count === 1;
  }

  async remove(scope: ProjectScope, projectMembershipId: string): Promise<boolean> {
    const result = await this.db.projectMembership.deleteMany({
      where: {
        id: projectMembershipId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
    });
    return result.count === 1;
  }

  async count(scope: ProjectScope): Promise<number> {
    return this.db.projectMembership.count({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    });
  }
}
