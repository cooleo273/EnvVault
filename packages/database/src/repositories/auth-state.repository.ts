import type { DbClient } from '../client.js';
import type { AuthRevocationReason, StepUpMethod } from '../generated/prisma/enums.js';

/** Upper bound enforced by the `auth_step_up_grants_lifetime_chk` constraint. */
export const MAX_STEP_UP_TTL_SECONDS = 3600;

/**
 * Application-owned authentication state that complements Neon Auth:
 * access-token revocation and step-up (re-verification) grants.
 */
export class AuthStateRepository {
  constructor(private readonly db: DbClient) {}

  /** Tokens for this user issued before the returned instant must be rejected. */
  async getTokensNotBefore(userId: string): Promise<Date | null> {
    const row = await this.db.authTokenRevocation.findUnique({
      where: { userId },
      select: { notBefore: true },
    });
    return row?.notBefore ?? null;
  }

  /**
   * Rejects all of the user's access tokens issued before `at`. Monotonic:
   * an earlier `at` never re-enables tokens revoked by a later call.
   */
  async revokeTokensIssuedBefore(
    userId: string,
    reason: AuthRevocationReason,
    at = new Date(),
  ): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO "auth_token_revocations" ("user_id", "not_before", "reason", "updated_at")
      VALUES (${userId}::uuid, ${at}, ${reason}::"AuthRevocationReason", now())
      ON CONFLICT ("user_id") DO UPDATE SET
        "not_before" = GREATEST("auth_token_revocations"."not_before", EXCLUDED."not_before"),
        "reason" = CASE
          WHEN EXCLUDED."not_before" >= "auth_token_revocations"."not_before" THEN EXCLUDED."reason"
          ELSE "auth_token_revocations"."reason"
        END,
        "updated_at" = now()`;
  }

  async createStepUpGrant(
    userId: string,
    method: StepUpMethod,
    ttlSeconds: number,
    now = new Date(),
  ): Promise<{ expiresAt: Date }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_STEP_UP_TTL_SECONDS) {
      throw new Error(
        `Step-up TTL must be between 1 and ${String(MAX_STEP_UP_TTL_SECONDS)} seconds`,
      );
    }
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.db.authStepUpGrant.create({
      data: { userId, method, createdAt: now, expiresAt },
    });
    return { expiresAt };
  }

  /** Expiry of the user's newest unexpired step-up grant, or null. */
  async findActiveStepUpExpiry(userId: string, now = new Date()): Promise<Date | null> {
    const grant = await this.db.authStepUpGrant.findFirst({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { expiresAt: 'desc' },
      select: { expiresAt: true },
    });
    return grant?.expiresAt ?? null;
  }

  /** Ends sudo mode (logout) and removes expired grants. */
  async clearStepUpGrants(userId: string): Promise<void> {
    await this.db.authStepUpGrant.deleteMany({ where: { userId } });
  }
}
