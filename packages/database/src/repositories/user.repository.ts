import type { DbClient } from '../client.js';
import { getConstraintViolation } from '../errors.js';
import type { UserStatus } from '../generated/prisma/enums.js';

/**
 * Identity attributes taken from a Neon Auth token that the API has already
 * verified (signature, issuer, audience, expiry). Never construct this from
 * client-supplied input.
 */
export interface VerifiedIdentity {
  /** Neon Auth user id (JWT `sub`). */
  authUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
}

export interface UserProfile {
  id: string;
  authUserId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  status: UserStatus;
  deleted: boolean;
}

const profileSelect = {
  id: true,
  authUserId: true,
  email: true,
  displayName: true,
  emailVerifiedAt: true,
  status: true,
  deletedAt: true,
} as const;

interface ProfileRow {
  id: string;
  authUserId: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  deletedAt: Date | null;
}

function toProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    authUserId: row.authUserId,
    email: row.email,
    displayName: row.displayName,
    emailVerified: row.emailVerifiedAt !== null,
    status: row.status,
    deleted: row.deletedAt !== null,
  };
}

export class UserRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Just-in-time provisioning: returns the EnvVault profile linked to a
   * verified Neon Auth identity, creating it on first use and refreshing the
   * cached email/name. Status (suspension, deletion) is never changed here.
   */
  async upsertFromIdentity(identity: VerifiedIdentity, now = new Date()): Promise<UserProfile> {
    const email = identity.email.toLowerCase();
    const displayName = identity.name?.trim() ? identity.name.trim().slice(0, 120) : null;

    const existing = await this.db.user.findUnique({
      where: { authUserId: identity.authUserId },
      select: profileSelect,
    });
    if (existing) {
      const verifiedAt = identity.emailVerified ? (existing.emailVerifiedAt ?? now) : null;
      const changed =
        existing.email !== email ||
        existing.displayName !== displayName ||
        (existing.emailVerifiedAt === null) !== (verifiedAt === null);
      if (!changed) return toProfile(existing);
      const updated = await this.db.user.update({
        where: { authUserId: identity.authUserId },
        data: { email, displayName, emailVerifiedAt: verifiedAt },
        select: profileSelect,
      });
      return toProfile(updated);
    }

    try {
      const created = await this.db.user.create({
        data: {
          authUserId: identity.authUserId,
          email,
          displayName,
          emailVerifiedAt: identity.emailVerified ? now : null,
        },
        select: profileSelect,
      });
      return toProfile(created);
    } catch (error) {
      // Two concurrent first requests for the same identity: the other won.
      if (getConstraintViolation(error)?.constraint === 'users_auth_user_id_key') {
        const winner = await this.db.user.findUniqueOrThrow({
          where: { authUserId: identity.authUserId },
          select: profileSelect,
        });
        return toProfile(winner);
      }
      throw error;
    }
  }

  /** The caller's own profile (by EnvVault user id from the verified principal). */
  async getAccount(userId: string): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    emailVerified: boolean;
    createdAt: Date;
    lastWorkspaceId: string | null;
  } | null> {
    const row = await this.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastWorkspaceId: true,
      },
    });
    if (!row) return null;
    const { emailVerifiedAt, ...rest } = row;
    return { ...rest, emailVerified: emailVerifiedAt !== null };
  }

  /**
   * Remembers the workspace the user last opened. A UI preference only:
   * callers must have authorized access to `workspaceId` first, and readers
   * must re-check membership before using it.
   */
  async setLastWorkspace(userId: string, workspaceId: string | null): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastWorkspaceId: workspaceId } });
  }

  /** Ids of live profiles with this (lower-case) email. Email is not unique. */
  async findIdsByEmail(email: string): Promise<string[]> {
    const rows = await this.db.user.findMany({
      where: { email: email.toLowerCase(), deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}
