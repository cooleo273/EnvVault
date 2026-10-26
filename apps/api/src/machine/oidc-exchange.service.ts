import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  createRepositories,
  type OidcBindingForExchange,
  type Repositories,
} from '@envvault/database';
import {
  githubMismatch,
  MACHINE_ERROR_CODES,
  MACHINE_LIMITS,
  type MachineToken,
  OIDC_ERROR_CODES,
  type oidcTokenInputSchema,
  protectedPolicyProblems,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import type { ResilientThrottlerStorage } from '../rate-limit/resilient.storage.js';
import { RATE_LIMIT_STORAGE, SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import { issueAccessToken } from './machine-tokens.js';
import {
  OIDC_VERIFIER,
  OidcVerificationError,
  type OidcVerifier,
  type VerifiedOidcToken,
} from './oidc-verifier.provider.js';

type Input = z.output<typeof oidcTokenInputSchema>;

function unauthorized(code: string, message: string): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, code, message, {
    'WWW-Authenticate': 'Bearer error="invalid_token"',
  });
}

const NO_BINDING = () =>
  unauthorized(
    OIDC_ERROR_CODES.OIDC_NO_MATCHING_BINDING,
    'No enabled trust binding accepts this workflow. A project admin can see why in the binding’s recent attempts.',
  );

/** Non secret workflow facts recorded with every attempt (never the token). */
function runContext(verified: VerifiedOidcToken): Record<string, string | null> {
  const c = verified.claims;
  return {
    method: 'github_oidc',
    repository: c.repository,
    repositoryId: c.repository_id,
    workflowRef: c.workflow_ref,
    jobWorkflowRef: c.job_workflow_ref,
    ref: c.ref,
    eventName: c.event_name,
    githubEnvironment: c.environment ?? null,
    runId: c.run_id ?? null,
    runAttempt: c.run_attempt ?? null,
    sha: c.sha ?? null,
  };
}

/**
 * GitHub Actions OIDC exchange: a verified GitHub identity token becomes a
 * Phase 4B machine access token for the identity of the one binding whose
 * conditions it meets. The binding makes the workflow eligible; what the
 * token can read is still decided per request by the identity's grants.
 * There is no refresh token: a job asks GitHub for a new identity token.
 */
@Injectable()
export class OidcExchangeService {
  private readonly logger = new Logger(OidcExchangeService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly limiter: SensitiveRateLimiter,
    @Inject(OIDC_VERIFIER) private readonly verifier: OidcVerifier,
    @Inject(RATE_LIMIT_STORAGE) private readonly storage: ResilientThrottlerStorage,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  async exchange(
    rawToken: string | null,
    input: Input,
    ip: string | null,
    requestId: string | null,
    now = new Date(),
  ): Promise<MachineToken> {
    if (!this.verifier.enabled) {
      throw unauthorized(OIDC_ERROR_CODES.OIDC_ISSUER_NOT_TRUSTED, 'OIDC exchange is turned off');
    }
    const verified = await this.verify(rawToken);
    const { claims } = verified;

    await this.limiter.consume({
      userId: `oidc:${verified.issuer}:${claims.repository_id}`,
      action: 'oidc-token',
    });
    // One exchange per identity token while it is valid (see docs/integrations/github-oidc.md).
    const ttl = Math.max(1_000, verified.expiresAt.getTime() - now.getTime() + 60_000);
    if (!(await this.limiter.claimOnce(`oidc-jti:${verified.issuer}:${verified.jti}`, ttl))) {
      throw unauthorized(
        OIDC_ERROR_CODES.OIDC_TOKEN_REPLAYED,
        'This identity token was already exchanged; request a new one from GitHub',
      );
    }

    const repos = this.repos;
    const candidates = await repos.oidcTrust.forExchange({
      issuer: verified.issuer,
      repositoryId: claims.repository_id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      bindingId: input.bindingId,
    });
    const context = runContext(verified);
    const eligible: OidcBindingForExchange[] = [];
    for (const binding of candidates) {
      const reason = this.ineligibility(binding, verified, now);
      if (reason) {
        await this.auditOncePerMinute(`oidc:${binding.id}:${reason}`, () =>
          this.audit(repos, binding, 'DENIED', { ...context, reason }, requestId),
        );
      } else {
        eligible.push(binding);
      }
    }
    if (eligible.length === 0) {
      if (candidates.length === 0) {
        this.logger.warn(`OIDC token from repository ${claims.repository_id} matched no binding`);
      }
      throw NO_BINDING();
    }
    if (eligible.length > 1) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        OIDC_ERROR_CODES.OIDC_BINDING_AMBIGUOUS,
        'Several trust bindings accept this workflow. Pass bindingId (or projectId) to choose one.',
      );
    }
    const [binding] = eligible;
    if (!binding) throw NO_BINDING();
    const refuse = async (reason: string, error: ApiException): Promise<never> => {
      await this.auditOncePerMinute(`oidc:${binding.id}:${reason}`, () =>
        this.audit(repos, binding, 'DENIED', { ...context, reason }, requestId),
      );
      throw error;
    };

    const scopes = input.scopes ?? binding.scopes;
    if (!scopes.every((s) => binding.scopes.includes(s))) {
      return refuse(
        'scope_not_granted',
        new ApiException(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.SCOPE_NOT_GRANTED,
          'The binding does not allow every requested scope',
        ),
      );
    }
    const allowed = new Set(binding.environmentIds.map((id) => id.toLowerCase()));
    const requested = input.environmentIds?.map((id) => id.toLowerCase());
    if (requested && !requested.every((id) => allowed.has(id))) {
      return refuse(
        'environment_not_in_binding',
        new ApiException(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.SCOPE_NOT_GRANTED,
          'A requested environment is not part of this trust binding',
        ),
      );
    }
    // Environments that still exist in the identity's project; grants are checked per request.
    const live = await repos.machineIdentities.environmentsWithGrants(
      binding.workspaceId,
      binding.identity.projectId,
      binding.identity.id,
    );
    const liveById = new Map(live.map((e) => [e.environment.id, e.environment]));
    const environmentIds = (requested ?? [...allowed]).filter((id) => liveById.has(id));
    if (environmentIds.length === 0) {
      return refuse(
        'no_environment',
        new ApiException(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.SCOPE_NOT_GRANTED,
          'None of the binding’s environments exist any more',
        ),
      );
    }
    // Protection can be switched on after the binding was created, so check again here.
    const reachesProtected = environmentIds.some((id) => liveById.get(id)?.isProtected === true);
    if (reachesProtected && protectedPolicyProblems(binding.conditions).length > 0) {
      return refuse(
        'protected_policy_required',
        new ApiException(
          HttpStatus.FORBIDDEN,
          OIDC_ERROR_CODES.OIDC_PROTECTED_POLICY_REQUIRED,
          'This binding reaches a protected environment but does not restrict events and branches or GitHub environments. Tighten it in the dashboard.',
        ),
      );
    }

    const limits = [
      now.getTime() + MACHINE_LIMITS.accessTokenTtlSeconds * 1000,
      binding.expiresAt.getTime(),
      ...(binding.identity.expiresAt ? [binding.identity.expiresAt.getTime()] : []),
    ];
    const expiresAt = new Date(Math.min(...limits));
    const issued = issueAccessToken();
    await repos.machineIdentities.createAccessToken({
      workspaceId: binding.workspaceId,
      serviceIdentityId: binding.identity.id,
      credentialId: binding.id,
      tokenHash: issued.hash,
      scopes: [...scopes],
      environmentIds,
      requestedIp: ip,
      expiresAt,
    });
    await repos.machineIdentities.recordAuthentication(binding.id, binding.identity.id, now);
    await this.audit(
      repos,
      binding,
      'SUCCESS',
      {
        ...context,
        scopes: [...scopes].join(' '),
        environmentCount: String(environmentIds.length),
        expiresInSeconds: String(Math.round((expiresAt.getTime() - now.getTime()) / 1000)),
      },
      requestId,
    );
    return {
      accessToken: issued.token,
      tokenType: 'Bearer',
      expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
      expiresAt: expiresAt.toISOString(),
      scopes: [...scopes] as MachineToken['scopes'],
      environmentIds,
      identity: {
        id: binding.identity.id,
        name: binding.identity.name,
        workspaceId: binding.workspaceId,
        projectId: binding.identity.projectId,
      },
      credential: {
        id: binding.id,
        name: binding.name,
        expiresAt: binding.expiresAt.toISOString(),
      },
    };
  }

  private async verify(rawToken: string | null): Promise<VerifiedOidcToken> {
    if (!rawToken) {
      throw unauthorized(
        OIDC_ERROR_CODES.OIDC_TOKEN_INVALID,
        'Send the GitHub OIDC token as a Bearer token',
      );
    }
    try {
      return await this.verifier.verify(rawToken);
    } catch (error) {
      if (!(error instanceof OidcVerificationError)) throw error;
      this.logger.warn(`OIDC token refused: ${error.reason}`);
      switch (error.reason) {
        case 'expired':
          throw unauthorized(OIDC_ERROR_CODES.OIDC_TOKEN_EXPIRED, 'The identity token expired');
        case 'untrusted_issuer':
          throw unauthorized(
            OIDC_ERROR_CODES.OIDC_ISSUER_NOT_TRUSTED,
            'The identity token issuer is not trusted by this EnvVault API',
          );
        case 'unavailable':
          throw new ApiException(
            HttpStatus.SERVICE_UNAVAILABLE,
            OIDC_ERROR_CODES.OIDC_PROVIDER_UNAVAILABLE,
            'The identity provider’s keys cannot be fetched right now. Try again shortly.',
            { 'Retry-After': '30' },
          );
        default:
          throw unauthorized(
            OIDC_ERROR_CODES.OIDC_TOKEN_INVALID,
            'The identity token is not valid',
          );
      }
    }
  }

  /** Why a binding cannot accept this token, or null. */
  private ineligibility(
    binding: OidcBindingForExchange,
    verified: VerifiedOidcToken,
    now: Date,
  ): string | null {
    // Exactly the binding's audience: a token minted for several services is refused.
    if (verified.audiences.length !== 1 || verified.audiences[0] !== binding.audience) {
      return 'audience';
    }
    const mismatch = githubMismatch(binding.conditions, verified.claims);
    if (mismatch) return mismatch;
    if (binding.revokedAt) return 'binding_deleted';
    if (binding.disabledAt) return 'binding_disabled';
    if (binding.expiresAt <= now) return 'binding_expired';
    if (binding.identity.deletedAt) return 'identity_retired';
    if (binding.identity.status !== 'ACTIVE') return 'identity_disabled';
    if (binding.identity.expiresAt && binding.identity.expiresAt <= now) return 'identity_expired';
    return null;
  }

  private async audit(
    repos: Repositories,
    binding: OidcBindingForExchange,
    outcome: 'SUCCESS' | 'DENIED',
    metadata: Record<string, string | null>,
    requestId: string | null,
  ): Promise<void> {
    await repos.audit.appendService({
      workspaceId: binding.workspaceId,
      projectId: binding.identity.projectId,
      actorServiceIdentityId: binding.identity.id,
      action: outcome === 'SUCCESS' ? 'machine.authenticated' : 'machine.authentication_failed',
      outcome,
      resourceType: 'service_identity',
      resourceId: binding.identity.id,
      requestId,
      metadata: { credentialId: binding.id, ...metadata },
    });
  }

  /** A retrying workflow is recorded once per minute and reason, not once per attempt. */
  private async auditOncePerMinute(key: string, write: () => Promise<void>): Promise<void> {
    try {
      const marker = await this.storage.increment(key, 60_000, 1, 0, 'audit-dedupe');
      if (!marker.isBlocked) await write();
    } catch {
      this.logger.error('Could not record a refused OIDC exchange');
    }
  }
}
