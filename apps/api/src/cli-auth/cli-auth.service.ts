import { createHash, randomBytes, randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type CliSessionRecord,
  createRepositories,
  getConstraintViolation,
  withTransaction,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  CLI_ERROR_CODES,
  CLI_LIMITS,
  type CliDeviceRequest,
  type CliDeviceStart,
  type CliDeviceStartInput,
  type CliSession,
  type CliToken,
  USER_CODE_ALPHABET,
} from '@envvault/shared';
import type { Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';

export const CLI_ACCESS_PREFIX = 'evv_at_';
const REFRESH_PREFIX = 'evv_rt_';
const DEVICE_PREFIX = 'evv_dc_';
const DAY_MS = 86_400_000;

/** 256 random bits behind a prefix that names the credential (for scanners and logs). */
function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/**
 * Tokens are 256 bit random values, so a plain SHA-256 is enough to make a
 * stolen table useless; no salt or slow hash is needed for that entropy.
 */
export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function newUserCode(): string {
  const pick = () => USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length));
  const half = () => Array.from({ length: 4 }, pick).join('');
  return `${half()}-${half()}`;
}

function grantError(code: string, message: string, status = HttpStatus.BAD_REQUEST): ApiException {
  return new ApiException(status, code, message);
}

function unauthorized(code: string, message: string): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, code, message, {
    'WWW-Authenticate': 'Bearer error="invalid_token"',
  });
}

/**
 * Browser approved CLI sign in. Neon Auth has no device or CLI flow, so
 * EnvVault brokers one, shaped after RFC 8628: the CLI asks for a code, the
 * person approves it in the web app while signed in through Neon Auth (with
 * a fresh password confirmation), and the CLI then receives EnvVault session
 * credentials: a one hour access token and a rotating 30 day refresh token,
 * within a 90 day session. Only their hashes are stored.
 */
@Injectable()
export class CliAuthService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  private get repos() {
    return createRepositories(this.database.client);
  }

  private appOrigin(): string {
    return this.env.APP_BASE_URL ?? this.env.CORS_ORIGINS[0] ?? 'http://localhost:3000';
  }

  async start(
    input: CliDeviceStartInput,
    ip: string | null,
    now = new Date(),
  ): Promise<CliDeviceStart> {
    const deviceCode = newToken(DEVICE_PREFIX);
    const expiresAt = new Date(now.getTime() + CLI_LIMITS.deviceTtlSeconds * 1000);
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      try {
        await this.repos.cliAuth.createDeviceGrant({
          deviceCodeHash: tokenHash(deviceCode),
          userCode,
          clientVersion: input.clientVersion,
          hostname: input.hostname,
          platform: input.platform,
          requestedIp: ip,
          expiresAt,
        });
        const verificationUri = `${this.appOrigin()}/cli/authorize`;
        return {
          deviceCode,
          userCode,
          verificationUri,
          verificationUriComplete: `${verificationUri}?code=${userCode}`,
          expiresIn: CLI_LIMITS.deviceTtlSeconds,
          interval: CLI_LIMITS.pollIntervalSeconds,
        };
      } catch (error) {
        // Another open request holds this code (one in 25 billion); draw again.
        if (
          attempt < 3 &&
          getConstraintViolation(error)?.constraint === 'cli_device_grants_pending_user_code_key'
        )
          continue;
        throw error;
      }
    }
  }

  /** The CLI's poll. Answers with RFC 8628 style error codes until the request is decided. */
  async poll(deviceCode: string, now = new Date()): Promise<CliToken> {
    const grant = await this.repos.cliAuth.deviceGrantByCode(tokenHash(deviceCode));
    if (!grant || grant.status === 'consumed') {
      throw grantError(
        CLI_ERROR_CODES.INVALID_GRANT,
        'This sign in request is not valid. Run envvault login again.',
      );
    }
    if (grant.status === 'denied') {
      throw grantError(CLI_ERROR_CODES.ACCESS_DENIED, 'The sign in request was denied.');
    }
    if (grant.expiresAt <= now) {
      throw grantError(
        CLI_ERROR_CODES.EXPIRED_TOKEN,
        'The sign in request expired. Run envvault login again.',
      );
    }
    if (grant.status === 'pending') {
      const allowed = await this.repos.cliAuth.recordPoll(
        grant.id,
        now,
        (CLI_LIMITS.pollIntervalSeconds - 1) * 1000,
      );
      throw allowed
        ? grantError(CLI_ERROR_CODES.AUTHORIZATION_PENDING, 'Waiting for approval in the browser.')
        : grantError(CLI_ERROR_CODES.SLOW_DOWN, 'Polling too fast.');
    }
    const userId = grant.userId;
    if (!userId)
      throw grantError(CLI_ERROR_CODES.INVALID_GRANT, 'This sign in request is not valid.');
    const profile = await this.repos.users.findProfile(userId);
    if (profile?.status !== 'ACTIVE' || profile.deleted) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        'Account disabled',
      );
    }
    const access = newToken(CLI_ACCESS_PREFIX);
    const refresh = newToken(REFRESH_PREFIX);
    const expiresAt = new Date(now.getTime() + CLI_LIMITS.sessionMaxDays * DAY_MS);
    const accessExpiresAt = new Date(now.getTime() + CLI_LIMITS.accessTokenTtlSeconds * 1000);
    const refreshExpiresAt = new Date(now.getTime() + CLI_LIMITS.refreshTokenTtlDays * DAY_MS);
    const session = await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      // One session per approval, even when two polls race.
      if (!(await repos.cliAuth.consume(grant.id))) return null;
      const created = await repos.cliAuth.createSession({
        userId,
        deviceGrantId: grant.id,
        clientVersion: grant.clientVersion,
        hostname: grant.hostname,
        platform: grant.platform,
        accessTokenHash: tokenHash(access),
        accessExpiresAt,
        refreshTokenHash: tokenHash(refresh),
        refreshExpiresAt,
        expiresAt,
      });
      await repos.audit.append({
        actorUserId: userId,
        action: 'auth.cli_session_created',
        outcome: 'SUCCESS',
        resourceType: 'cli_session',
        resourceId: created.id,
        metadata: {
          hostname: grant.hostname,
          platform: grant.platform,
          clientVersion: grant.clientVersion,
        },
      });
      return created;
    });
    if (!session)
      throw grantError(CLI_ERROR_CODES.INVALID_GRANT, 'This sign in request was already used.');
    return this.tokens(session, access, refresh, now);
  }

  private tokens(session: CliSessionRecord, access: string, refresh: string, now: Date): CliToken {
    return {
      tokenType: 'Bearer',
      accessToken: access,
      refreshToken: refresh,
      expiresIn: Math.max(
        0,
        Math.floor((session.accessExpiresAt.getTime() - now.getTime()) / 1000),
      ),
      refreshExpiresAt: session.refreshExpiresAt.toISOString(),
      sessionId: session.id,
    };
  }

  /**
   * Rotates both tokens. A refresh token that was already rotated away is
   * proof that someone copied it, so the whole session ends.
   */
  async refresh(refreshToken: string, now = new Date()): Promise<CliToken> {
    const hash = tokenHash(refreshToken);
    const repos = this.repos;
    const session = await repos.cliAuth.sessionByRefreshToken(hash);
    if (!session) {
      const reused = await repos.cliAuth.sessionByPreviousRefreshToken(hash);
      if (reused && !reused.revokedAt) {
        await repos.cliAuth.revoke(reused.id, 'refresh_reuse', now);
        await repos.audit.append({
          actorUserId: reused.userId,
          action: 'auth.cli_refresh_reused',
          outcome: 'DENIED',
          resourceType: 'cli_session',
          resourceId: reused.id,
          metadata: { hostname: reused.hostname },
        });
      }
      throw unauthorized(
        AUTH_ERROR_CODES.TOKEN_REVOKED,
        'This CLI session has ended. Run envvault login.',
      );
    }
    if (session.revokedAt) {
      throw unauthorized(
        AUTH_ERROR_CODES.TOKEN_REVOKED,
        'This CLI session has ended. Run envvault login.',
      );
    }
    if (session.refreshExpiresAt <= now || session.expiresAt <= now) {
      throw unauthorized(
        AUTH_ERROR_CODES.TOKEN_EXPIRED,
        'This CLI session expired. Run envvault login.',
      );
    }
    await this.assertUsable(session, now);
    const access = newToken(CLI_ACCESS_PREFIX);
    const refresh = newToken(REFRESH_PREFIX);
    const accessExpiresAt = new Date(
      Math.min(
        now.getTime() + CLI_LIMITS.accessTokenTtlSeconds * 1000,
        session.expiresAt.getTime(),
      ),
    );
    const refreshExpiresAt = new Date(
      Math.min(
        now.getTime() + CLI_LIMITS.refreshTokenTtlDays * DAY_MS,
        session.expiresAt.getTime(),
      ),
    );
    const rotated = await repos.cliAuth.rotate(
      session.id,
      hash,
      {
        accessTokenHash: tokenHash(access),
        accessExpiresAt,
        refreshTokenHash: tokenHash(refresh),
        refreshExpiresAt,
      },
      now,
    );
    if (!rotated)
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_INVALID, 'Refresh failed. Run envvault login.');
    return this.tokens({ ...session, accessExpiresAt, refreshExpiresAt }, access, refresh, now);
  }

  /**
   * The account must still be active, and the session must postdate the
   * last "sign out everywhere" or password change.
   */
  async assertUsable(session: CliSessionRecord, now = new Date()): Promise<void> {
    const repos = this.repos;
    const [profile, notBefore] = await Promise.all([
      repos.users.findProfile(session.userId),
      repos.authState.getTokensNotBefore(session.userId),
    ]);
    if (profile?.status !== 'ACTIVE' || profile.deleted) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        'Account disabled',
      );
    }
    if (notBefore && session.createdAt.getTime() < notBefore.getTime()) {
      await repos.cliAuth.revoke(session.id, 'sign_out_everywhere', now);
      throw unauthorized(
        AUTH_ERROR_CODES.TOKEN_REVOKED,
        'This CLI session has ended. Run envvault login.',
      );
    }
  }

  private async pending(userCode: string, now: Date) {
    const grant = await this.repos.cliAuth.pendingByUserCode(userCode, now);
    if (!grant) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'No open sign in request has this code. Check the code, or run envvault login again.',
      );
    }
    return grant;
  }

  async lookup(userCode: string, now = new Date()): Promise<CliDeviceRequest> {
    const grant = await this.pending(userCode, now);
    return {
      userCode: grant.userCode,
      clientVersion: grant.clientVersion,
      hostname: grant.hostname,
      platform: grant.platform,
      requestedAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  async decide(
    principal: Principal,
    userCode: string,
    decision: 'approved' | 'denied',
    requestId: string | null,
    now = new Date(),
  ): Promise<void> {
    if (principal.cliSessionId) {
      // A CLI cannot approve another CLI: approval proves a browser session.
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        CLI_ERROR_CODES.CLI_TOKEN_NOT_ALLOWED,
        'Approve sign in requests in the web app',
      );
    }
    const grant = await this.pending(userCode, now);
    if (!(await this.repos.cliAuth.decide(grant.id, decision, principal.userId, now))) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'This sign in request was already decided or expired.',
      );
    }
    await this.repos.audit.append({
      actorUserId: principal.userId,
      action: decision === 'approved' ? 'auth.cli_login_approved' : 'auth.cli_login_denied',
      outcome: 'SUCCESS',
      resourceType: 'cli_device_grant',
      resourceId: grant.id,
      requestId,
      metadata: {
        hostname: grant.hostname,
        platform: grant.platform,
        clientVersion: grant.clientVersion,
      },
    });
  }

  async sessions(principal: Principal, now = new Date()): Promise<CliSession[]> {
    const rows = await this.repos.cliAuth.activeForUser(principal.userId, now);
    return rows.map((s) => ({
      id: s.id,
      hostname: s.hostname,
      platform: s.platform,
      clientVersion: s.clientVersion,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
      expiresAt: new Date(
        Math.min(s.refreshExpiresAt.getTime(), s.expiresAt.getTime()),
      ).toISOString(),
      current: s.id === principal.cliSessionId,
    }));
  }

  async revoke(
    principal: Principal,
    sessionId: string,
    reason: string,
    requestId: string | null,
  ): Promise<void> {
    const now = new Date();
    if (!(await this.repos.cliAuth.revoke(sessionId, reason, now, principal.userId))) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    }
    await this.repos.audit.append({
      actorUserId: principal.userId,
      action: 'auth.cli_session_revoked',
      outcome: 'SUCCESS',
      resourceType: 'cli_session',
      resourceId: sessionId,
      requestId,
      metadata: { reason },
    });
  }
}
