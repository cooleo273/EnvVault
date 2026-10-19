import type { DbClient } from '../client.js';
import type { InvitationStatus } from '../generated/prisma/enums.js';
import type { WorkspaceScope } from '../scope.js';

export interface InvitationRecord {
  id: string;
  workspaceId: string;
  email: string;
  role: { id: string; key: string; name: string };
  /** Stored status; PENDING rows past `expiresAt` are effectively expired. */
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { displayName: string | null; email: string } | null;
}

export interface ReceivedInvitationRecord {
  id: string;
  workspaceId: string;
  email: string;
  workspace: { name: string; slug: string };
  role: { id: string; key: string; name: string };
  invitedBy: { displayName: string | null } | null;
  expiresAt: Date;
}

const invitationSelect = {
  id: true,
  workspaceId: true,
  email: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
  invitedBy: { select: { displayName: true, email: true } },
} as const;

const receivedSelect = {
  id: true,
  workspaceId: true,
  email: true,
  expiresAt: true,
  workspace: { select: { name: true, slug: true } },
  role: { select: { id: true, key: true, name: true } },
  invitedBy: { select: { displayName: true } },
} as const;

/** The status a client should see: unexpired PENDING stays PENDING. */
export function effectiveInvitationStatus(
  invitation: { status: InvitationStatus; expiresAt: Date },
  now = new Date(),
): InvitationStatus {
  return invitation.status === 'PENDING' && invitation.expiresAt <= now
    ? 'EXPIRED'
    : invitation.status;
}

/**
 * Workspace invitations. Tokens never reach this layer: callers pass the
 * SHA-256 hash (32 bytes). Every state change is a conditional update on
 * `status = 'PENDING'` (and expiry), so an invitation can be used, declined
 * or revoked at most once even under concurrent requests.
 */
export class InvitationRepository {
  constructor(private readonly db: DbClient) {}

  /** Marks the email's stale PENDING invitation as EXPIRED so a new one can be issued. */
  async expireStale(scope: WorkspaceScope, email: string, now = new Date()): Promise<void> {
    await this.db.workspaceInvitation.updateMany({
      where: { workspaceId: scope.workspaceId, email, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
  }

  async hasPending(scope: WorkspaceScope, email: string, now = new Date()): Promise<boolean> {
    const row = await this.db.workspaceInvitation.findFirst({
      where: { workspaceId: scope.workspaceId, email, status: 'PENDING', expiresAt: { gt: now } },
      select: { id: true },
    });
    return row !== null;
  }

  async create(
    scope: WorkspaceScope,
    data: {
      email: string;
      roleId: string;
      tokenHash: Uint8Array<ArrayBuffer>;
      expiresAt: Date;
      invitedById: string;
    },
  ): Promise<InvitationRecord> {
    return this.db.workspaceInvitation.create({
      data: { workspaceId: scope.workspaceId, ...data },
      select: invitationSelect,
    });
  }

  /** Recent invitations of the workspace, newest first. */
  async listForWorkspace(scope: WorkspaceScope, limit = 200): Promise<InvitationRecord[]> {
    return this.db.workspaceInvitation.findMany({
      where: { workspaceId: scope.workspaceId },
      select: invitationSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findForWorkspace(scope: WorkspaceScope, id: string): Promise<InvitationRecord | null> {
    return this.db.workspaceInvitation.findFirst({
      where: { id, workspaceId: scope.workspaceId },
      select: invitationSelect,
    });
  }

  /** Revokes a PENDING invitation. False if it was no longer pending. */
  async revoke(scope: WorkspaceScope, id: string, now = new Date()): Promise<boolean> {
    const result = await this.db.workspaceInvitation.updateMany({
      where: { id, workspaceId: scope.workspaceId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: now },
    });
    return result.count === 1;
  }

  /** A usable invitation (pending, unexpired, live and unarchived workspace) by token hash. */
  async findUsableByTokenHash(
    tokenHash: Uint8Array<ArrayBuffer>,
    now = new Date(),
  ): Promise<ReceivedInvitationRecord | null> {
    return this.db.workspaceInvitation.findFirst({
      where: {
        tokenHash,
        status: 'PENDING',
        expiresAt: { gt: now },
        workspace: { deletedAt: null, archivedAt: null },
      },
      select: receivedSelect,
    });
  }

  /** A usable invitation addressed to `email`, by id (in-app acceptance). */
  async findUsableForEmail(
    id: string,
    email: string,
    now = new Date(),
  ): Promise<ReceivedInvitationRecord | null> {
    return this.db.workspaceInvitation.findFirst({
      where: {
        id,
        email,
        status: 'PENDING',
        expiresAt: { gt: now },
        workspace: { deletedAt: null, archivedAt: null },
      },
      select: receivedSelect,
    });
  }

  async listUsableForEmail(email: string, now = new Date()): Promise<ReceivedInvitationRecord[]> {
    return this.db.workspaceInvitation.findMany({
      where: {
        email,
        status: 'PENDING',
        expiresAt: { gt: now },
        workspace: { deletedAt: null, archivedAt: null },
      },
      select: receivedSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async countUsableForEmail(email: string, now = new Date()): Promise<number> {
    return this.db.workspaceInvitation.count({
      where: {
        email,
        status: 'PENDING',
        expiresAt: { gt: now },
        workspace: { deletedAt: null, archivedAt: null },
      },
    });
  }

  /** Single use: true only for the one request that moved it out of PENDING. */
  async markAccepted(id: string, userId: string, now = new Date()): Promise<boolean> {
    const result = await this.db.workspaceInvitation.updateMany({
      where: { id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', acceptedById: userId, acceptedAt: now },
    });
    return result.count === 1;
  }

  async markDeclined(id: string, now = new Date()): Promise<boolean> {
    const result = await this.db.workspaceInvitation.updateMany({
      where: { id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'DECLINED', declinedAt: now },
    });
    return result.count === 1;
  }
}
