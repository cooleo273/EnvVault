import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createRepositories, type Repositories } from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  MACHINE_ERROR_CODES,
  MACHINE_LIMITS,
  type MachineToken,
  type MachineTokenInput,
  type machineTokenInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import type { MachinePrincipal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { INTEGRITY_RUNTIME, type IntegrityRuntime } from '../integrity/integrity.config.js';
import type { ResilientThrottlerStorage } from '../rate-limit/resilient.storage.js';
import { RATE_LIMIT_STORAGE, SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import {
  accessTokenHash,
  issueAccessToken,
  parseCredentialToken,
  verifyCredentialSecret,
} from './machine-tokens.js';

type TokenInput = z.output<typeof machineTokenInputSchema>;

function unauthorized(code: string, message: string): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, code, message, {
    'WWW-Authenticate': 'Bearer error="invalid_token"',
  });
}

const INVALID = () =>
  unauthorized(MACHINE_ERROR_CODES.INVALID_CREDENTIAL, 'The service credential is not valid');

/**
 * Machine authentication. A service credential is exchanged for an access
 * token of at most 15 minutes, narrowed to some of its scopes and
 * environments if asked. Every request with that token checks token,
 * credential and identity, so disabling, revoking or expiring any of them
 * stops the next request. Nothing here creates or consults a user.
 */
@Injectable()
export class MachineAuthService {
  private readonly logger = new Logger(MachineAuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly limiter: SensitiveRateLimiter,
    @Inject(INTEGRITY_RUNTIME) private readonly integrity: IntegrityRuntime,
    @Inject(RATE_LIMIT_STORAGE) private readonly storage: ResilientThrottlerStorage,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  /** False without INTEGRITY_KEY_FILE: credentials issued now stop working at restart. */
  get durable(): boolean {
    return this.integrity.status === 'configured';
  }

  get keys() {
    return this.integrity.keys;
  }

  async exchange(
    rawCredential: string | null,
    input: TokenInput | MachineTokenInput,
    ip: string | null,
    requestId: string | null,
    now = new Date(),
  ): Promise<MachineToken> {
    const parsed = rawCredential ? parseCredentialToken(rawCredential) : null;
    if (!parsed) throw INVALID();
    await this.limiter.consume({
      userId: `credential:${parsed.lookupId}`,
      action: 'machine-token',
    });

    const repos = this.repos;
    const credential = await repos.machineIdentities.credentialForExchange(parsed.lookupId);
    if (!credential) throw INVALID();
    const identity = credential.identity;
    const audit = async (outcome: 'SUCCESS' | 'DENIED', metadata: Record<string, unknown>) => {
      await repos.audit.appendService({
        workspaceId: credential.workspaceId,
        projectId: identity.projectId,
        actorServiceIdentityId: identity.id,
        action: outcome === 'SUCCESS' ? 'machine.authenticated' : 'machine.authentication_failed',
        outcome,
        resourceType: 'service_identity',
        resourceId: identity.id,
        requestId,
        metadata: { credentialId: credential.id, ...metadata },
      });
    };
    const refuse = async (reason: string, error: ApiException): Promise<never> => {
      await this.auditOncePerMinute(`machine-auth:${credential.id}:${reason}`, () =>
        audit('DENIED', { reason }),
      );
      throw error;
    };

    if (
      !verifyCredentialSecret(this.keys, parsed, {
        digest: credential.secretHash,
        digestKeyId: credential.digestKeyId,
      })
    ) {
      return refuse('invalid_secret', INVALID());
    }
    // Past this point the caller holds the real credential, so precise reasons help it.
    if (credential.revokedAt || identity.deletedAt) {
      return refuse(
        'credential_revoked',
        unauthorized(MACHINE_ERROR_CODES.CREDENTIAL_REVOKED, 'This service credential was revoked'),
      );
    }
    if (credential.expiresAt <= now) {
      return refuse(
        'credential_expired',
        unauthorized(MACHINE_ERROR_CODES.CREDENTIAL_EXPIRED, 'This service credential expired'),
      );
    }
    if (identity.status !== 'ACTIVE') {
      return refuse(
        'identity_disabled',
        unauthorized(MACHINE_ERROR_CODES.IDENTITY_DISABLED, 'This machine identity is disabled'),
      );
    }
    if (identity.expiresAt && identity.expiresAt <= now) {
      return refuse(
        'identity_expired',
        unauthorized(MACHINE_ERROR_CODES.IDENTITY_EXPIRED, 'This machine identity expired'),
      );
    }

    const scopes = input.scopes ?? credential.scopes;
    if (!scopes.every((scope) => credential.scopes.includes(scope))) {
      return refuse(
        'scope_not_granted',
        new ApiException(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.SCOPE_NOT_GRANTED,
          'The credential does not have every requested scope',
        ),
      );
    }
    const environmentIds = [...(input.environmentIds ?? [])].map((id) => id.toLowerCase());
    if (environmentIds.length > 0) {
      const live = new Set(
        (
          await repos.machineIdentities.environmentsWithGrants(
            credential.workspaceId,
            identity.projectId,
            identity.id,
          )
        ).map((e) => e.environment.id),
      );
      if (!environmentIds.every((id) => live.has(id))) {
        return refuse(
          'environment_not_available',
          new ApiException(
            HttpStatus.FORBIDDEN,
            MACHINE_ERROR_CODES.SCOPE_NOT_GRANTED,
            'A requested environment is not available to this identity',
          ),
        );
      }
    }

    const limits = [
      now.getTime() + MACHINE_LIMITS.accessTokenTtlSeconds * 1000,
      credential.expiresAt.getTime(),
      ...(identity.expiresAt ? [identity.expiresAt.getTime()] : []),
    ];
    const expiresAt = new Date(Math.min(...limits));
    const issued = issueAccessToken();
    await repos.machineIdentities.createAccessToken({
      workspaceId: credential.workspaceId,
      serviceIdentityId: identity.id,
      credentialId: credential.id,
      tokenHash: issued.hash,
      scopes: [...scopes],
      environmentIds,
      requestedIp: ip,
      expiresAt,
    });
    await repos.machineIdentities.recordAuthentication(credential.id, identity.id, now);
    await audit('SUCCESS', {
      scopes: [...scopes],
      environmentCount: environmentIds.length,
      expiresInSeconds: Math.round((expiresAt.getTime() - now.getTime()) / 1000),
    });
    return {
      accessToken: issued.token,
      tokenType: 'Bearer',
      expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
      expiresAt: expiresAt.toISOString(),
      scopes: [...scopes] as MachineToken['scopes'],
      environmentIds,
      identity: {
        id: identity.id,
        name: identity.name,
        workspaceId: credential.workspaceId,
        projectId: identity.projectId,
      },
      credential: {
        id: credential.id,
        name: credential.name,
        expiresAt: credential.expiresAt.toISOString(),
      },
    };
  }

  /** Resolves a machine access token for one request, or refuses it. */
  async authenticate(token: string, now = new Date()): Promise<MachinePrincipal> {
    const repos = this.repos;
    const record = await repos.machineIdentities.tokenByHash(accessTokenHash(token));
    if (!record) throw unauthorized(AUTH_ERROR_CODES.TOKEN_INVALID, 'Invalid access token');
    const refuse = async (reason: string, error: ApiException): Promise<never> => {
      await this.auditOncePerMinute(`machine-token:${record.id}:${reason}`, () =>
        repos.audit.appendService({
          workspaceId: record.workspaceId,
          projectId: record.identity.projectId,
          actorServiceIdentityId: record.serviceIdentityId,
          action: 'machine.token_rejected',
          outcome: 'DENIED',
          resourceType: 'service_identity',
          resourceId: record.serviceIdentityId,
          metadata: { credentialId: record.credentialId, reason },
        }),
      );
      throw error;
    };
    if (record.revokedAt) {
      return refuse(
        'token_revoked',
        unauthorized(AUTH_ERROR_CODES.TOKEN_REVOKED, 'Access token revoked'),
      );
    }
    if (record.expiresAt <= now) {
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_EXPIRED, 'Access token expired');
    }
    const { credential, identity } = record;
    if (credential.revokedAt || identity.deletedAt) {
      return refuse(
        'credential_revoked',
        unauthorized(MACHINE_ERROR_CODES.CREDENTIAL_REVOKED, 'This service credential was revoked'),
      );
    }
    if (!credential.expiresAt || credential.expiresAt <= now) {
      return refuse(
        'credential_expired',
        unauthorized(MACHINE_ERROR_CODES.CREDENTIAL_EXPIRED, 'This service credential expired'),
      );
    }
    if (identity.status !== 'ACTIVE' || (identity.expiresAt && identity.expiresAt <= now)) {
      return refuse(
        'identity_disabled',
        unauthorized(
          MACHINE_ERROR_CODES.IDENTITY_DISABLED,
          'This machine identity is disabled or expired',
        ),
      );
    }
    await repos.machineIdentities.touch(record.serviceIdentityId, identity.lastUsedAt, now);
    return {
      serviceIdentityId: record.serviceIdentityId,
      identityName: identity.name,
      workspaceId: record.workspaceId,
      projectId: identity.projectId,
      credentialId: record.credentialId,
      credentialName: credential.name,
      credentialExpiresAt: credential.expiresAt,
      tokenId: record.id,
      tokenExpiresAt: record.expiresAt,
      scopes: new Set(record.scopes),
      environmentIds: record.environmentIds,
    };
  }

  async revokeToken(machine: MachinePrincipal, requestId: string | null): Promise<void> {
    const repos = this.repos;
    await repos.machineIdentities.revokeToken(machine.tokenId, new Date());
    await repos.audit.appendService({
      workspaceId: machine.workspaceId,
      projectId: machine.projectId,
      actorServiceIdentityId: machine.serviceIdentityId,
      action: 'machine.token_revoked',
      outcome: 'SUCCESS',
      resourceType: 'service_identity',
      resourceId: machine.serviceIdentityId,
      requestId,
      metadata: { credentialId: machine.credentialId },
    });
  }

  /** A retrying client is recorded once per minute and reason, not once per attempt. */
  private async auditOncePerMinute(key: string, write: () => Promise<void>): Promise<void> {
    try {
      const marker = await this.storage.increment(key, 60_000, 1, 0, 'audit-dedupe');
      if (!marker.isBlocked) await write();
    } catch {
      this.logger.error('Could not record a refused machine authentication');
    }
  }
}
