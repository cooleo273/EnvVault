import type { DbClient } from '../client.js';
import type { RoleScope } from '../generated/prisma/enums.js';
import type { WorkspaceScope } from '../scope.js';

export interface ActiveMembership {
  membershipId: string;
  workspaceId: string;
  userId: string;
  role: { id: string; key: string; name: string; scope: RoleScope };
  permissions: string[];
  /** Archived workspaces are read-only; the API enforces that per route. */
  workspaceArchived: boolean;
}

export interface MemberRecord {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: { id: string; key: string; name: string };
  joinedAt: Date;
}

const memberSelect = {
  id: true,
  createdAt: true,
  user: { select: { id: true, email: true, displayName: true } },
  role: { select: { id: true, key: true, name: true } },
} as const;

interface MemberRow {
  id: string;
  createdAt: Date;
  user: { id: string; email: string; displayName: string | null };
  role: { id: string; key: string; name: string };
}

function toMember(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    role: row.role,
    joinedAt: row.createdAt,
  };
}

/**
 * Workspace memberships. `findActiveMembership` is the authorization
 * primitive used by the API before it creates a WorkspaceScope, which is why
 * it alone takes a raw workspace id; every other method requires a scope.
 */
export class MembershipRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Returns the caller's active membership, or null. Default deny: suspended
   * memberships, inactive or deleted users and deleted workspaces all yield null.
   */
  async findActiveMembership(
    workspaceId: string,
    userId: string,
  ): Promise<ActiveMembership | null> {
    const membership = await this.db.workspaceMembership.findFirst({
      where: {
        workspaceId,
        userId,
        status: 'ACTIVE',
        workspace: { deletedAt: null },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        workspace: { select: { archivedAt: true } },
        role: {
          select: {
            id: true,
            key: true,
            name: true,
            scope: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });
    if (!membership) {
      return null;
    }
    const { role } = membership;
    return {
      membershipId: membership.id,
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: { id: role.id, key: role.key, name: role.name, scope: role.scope },
      permissions: role.permissions.map((rp) => rp.permission.key).sort(),
      workspaceArchived: membership.workspace.archivedAt !== null,
    };
  }

  /** ACTIVE members of live user accounts, owners first. */
  async listMembers(scope: WorkspaceScope): Promise<MemberRecord[]> {
    const rows = await this.db.workspaceMembership.findMany({
      where: {
        workspaceId: scope.workspaceId,
        status: 'ACTIVE',
        user: { deletedAt: null },
      },
      select: memberSelect,
      orderBy: [{ createdAt: 'asc' }],
    });
    const rank = (key: string) => {
      const index = ['owner', 'admin', 'member', 'viewer'].indexOf(key);
      return index === -1 ? 99 : index;
    };
    return rows.map(toMember).sort((a, b) => rank(a.role.key) - rank(b.role.key));
  }

  async findMember(scope: WorkspaceScope, membershipId: string): Promise<MemberRecord | null> {
    const row = await this.db.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId: scope.workspaceId, status: 'ACTIVE' },
      select: memberSelect,
    });
    return row ? toMember(row) : null;
  }

  async isMember(scope: WorkspaceScope, userId: string): Promise<boolean> {
    const row = await this.db.workspaceMembership.findFirst({
      where: { workspaceId: scope.workspaceId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  async countActiveOwners(scope: WorkspaceScope): Promise<number> {
    return this.db.workspaceMembership.count({
      where: { workspaceId: scope.workspaceId, status: 'ACTIVE', role: { key: 'owner' } },
    });
  }

  async setRole(scope: WorkspaceScope, membershipId: string, roleId: string): Promise<boolean> {
    const result = await this.db.workspaceMembership.updateMany({
      where: { id: membershipId, workspaceId: scope.workspaceId, status: 'ACTIVE' },
      data: { roleId },
    });
    return result.count === 1;
  }

  async add(scope: WorkspaceScope, userId: string, roleId: string): Promise<string> {
    const created = await this.db.workspaceMembership.create({
      data: { workspaceId: scope.workspaceId, userId, roleId },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Removes a membership (and, by cascade, its project memberships and access
   * policies). History stays in the audit log. The database refuses to remove
   * the last owner.
   */
  async remove(scope: WorkspaceScope, membershipId: string): Promise<boolean> {
    const result = await this.db.workspaceMembership.deleteMany({
      where: { id: membershipId, workspaceId: scope.workspaceId },
    });
    return result.count === 1;
  }
}
