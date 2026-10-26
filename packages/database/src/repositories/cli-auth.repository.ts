import type { DbClient } from '../client.js';

export type DeviceGrantStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceGrantRecord {
  id: string;
  userCode: string;
  status: DeviceGrantStatus;
  clientVersion: string;
  hostname: string;
  platform: string;
  userId: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastPolledAt: Date | null;
}

export interface CliSessionRecord {
  id: string;
  userId: string;
  clientVersion: string;
  hostname: string;
  platform: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewCliSession {
  userId: string;
  deviceGrantId: string | null;
  clientVersion: string;
  hostname: string;
  platform: string;
  accessTokenHash: Buffer;
  accessExpiresAt: Date;
  refreshTokenHash: Buffer;
  refreshExpiresAt: Date;
  expiresAt: Date;
}

const grantSelect = {
  id: true,
  userCode: true,
  status: true,
  clientVersion: true,
  hostname: true,
  platform: true,
  userId: true,
  createdAt: true,
  expiresAt: true,
  lastPolledAt: true,
} as const;

const sessionSelect = {
  id: true,
  userId: true,
  clientVersion: true,
  hostname: true,
  platform: true,
  accessExpiresAt: true,
  refreshExpiresAt: true,
  expiresAt: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

const bytes = (b: Buffer) => new Uint8Array(b);

/**
 * Device authorization requests and CLI sessions. Codes and tokens arrive
 * already hashed: the repository never sees a usable credential.
 */
export class CliAuthRepository {
  constructor(private readonly db: DbClient) {}

  createDeviceGrant(data: {
    deviceCodeHash: Buffer;
    userCode: string;
    clientVersion: string;
    hostname: string;
    platform: string;
    requestedIp: string | null;
    expiresAt: Date;
  }): Promise<DeviceGrantRecord> {
    return this.db.cliDeviceGrant.create({
      data: { ...data, deviceCodeHash: bytes(data.deviceCodeHash) },
      select: grantSelect,
    }) as Promise<DeviceGrantRecord>;
  }

  deviceGrantByCode(deviceCodeHash: Buffer): Promise<DeviceGrantRecord | null> {
    return this.db.cliDeviceGrant.findUnique({
      where: { deviceCodeHash: bytes(deviceCodeHash) },
      select: grantSelect,
    }) as Promise<DeviceGrantRecord | null>;
  }

  pendingByUserCode(userCode: string, now: Date): Promise<DeviceGrantRecord | null> {
    return this.db.cliDeviceGrant.findFirst({
      where: { userCode, status: 'pending', expiresAt: { gt: now } },
      select: grantSelect,
    }) as Promise<DeviceGrantRecord | null>;
  }

  /** Records a poll; returns false when the previous one was too recent (slow down). */
  async recordPoll(id: string, now: Date, minIntervalMs: number): Promise<boolean> {
    const result = await this.db.cliDeviceGrant.updateMany({
      where: {
        id,
        OR: [
          { lastPolledAt: null },
          { lastPolledAt: { lte: new Date(now.getTime() - minIntervalMs) } },
        ],
      },
      data: { lastPolledAt: now },
    });
    return result.count === 1;
  }

  /** Decides a pending, unexpired request. Returns false when it is no longer pending. */
  async decide(
    id: string,
    decision: 'approved' | 'denied',
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.cliDeviceGrant.updateMany({
      where: { id, status: 'pending', expiresAt: { gt: now } },
      data: { status: decision, decidedAt: now, ...(decision === 'approved' ? { userId } : {}) },
    });
    return result.count === 1;
  }

  /** Marks an approved request as used, once. Run in the transaction that creates the session. */
  async consume(id: string): Promise<boolean> {
    const result = await this.db.cliDeviceGrant.updateMany({
      where: { id, status: 'approved' },
      data: { status: 'consumed' },
    });
    return result.count === 1;
  }

  async createSession(data: NewCliSession): Promise<CliSessionRecord> {
    return this.db.cliSession.create({
      data: {
        ...data,
        accessTokenHash: bytes(data.accessTokenHash),
        refreshTokenHash: bytes(data.refreshTokenHash),
      },
      select: sessionSelect,
    });
  }

  sessionByAccessToken(hash: Buffer): Promise<CliSessionRecord | null> {
    return this.db.cliSession.findUnique({
      where: { accessTokenHash: bytes(hash) },
      select: sessionSelect,
    });
  }

  sessionByRefreshToken(hash: Buffer): Promise<CliSessionRecord | null> {
    return this.db.cliSession.findUnique({
      where: { refreshTokenHash: bytes(hash) },
      select: sessionSelect,
    });
  }

  /** A session whose previous refresh token is presented again: the token was copied. */
  sessionByPreviousRefreshToken(hash: Buffer): Promise<CliSessionRecord | null> {
    return this.db.cliSession.findFirst({
      where: { previousRefreshTokenHash: bytes(hash) },
      select: sessionSelect,
    });
  }

  /**
   * Replaces both tokens if the refresh token is still the current one
   * (compare and set), so two concurrent refreshes cannot both succeed.
   */
  async rotate(
    id: string,
    presentedRefreshHash: Buffer,
    next: {
      accessTokenHash: Buffer;
      accessExpiresAt: Date;
      refreshTokenHash: Buffer;
      refreshExpiresAt: Date;
    },
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.cliSession.updateMany({
      where: { id, refreshTokenHash: bytes(presentedRefreshHash), revokedAt: null },
      data: {
        accessTokenHash: bytes(next.accessTokenHash),
        accessExpiresAt: next.accessExpiresAt,
        refreshTokenHash: bytes(next.refreshTokenHash),
        previousRefreshTokenHash: bytes(presentedRefreshHash),
        refreshExpiresAt: next.refreshExpiresAt,
        lastUsedAt: now,
      },
    });
    return result.count === 1;
  }

  /** Records use at most once a minute, so authentication does not write on every request. */
  async touch(id: string, now: Date): Promise<void> {
    await this.db.cliSession.updateMany({
      where: {
        id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 60_000) } }],
      },
      data: { lastUsedAt: now },
    });
  }

  async revoke(id: string, reason: string, now: Date, userId?: string): Promise<boolean> {
    const result = await this.db.cliSession.updateMany({
      where: { id, revokedAt: null, ...(userId ? { userId } : {}) },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count === 1;
  }

  async revokeAllForUser(userId: string, reason: string, now: Date): Promise<number> {
    const result = await this.db.cliSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count;
  }

  activeForUser(userId: string, now: Date): Promise<CliSessionRecord[]> {
    return this.db.cliSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now }, refreshExpiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: sessionSelect,
    });
  }
}
