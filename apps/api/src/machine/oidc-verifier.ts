import { Logger } from '@nestjs/common';
import { type GithubClaims, githubClaimsSchema, OIDC_LIMITS } from '@envvault/shared';
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Asymmetric algorithms only; `none` and HMAC are never accepted. GitHub signs with RS256. */
export const OIDC_ALGORITHMS = ['RS256', 'ES256'];

const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 3_000;
const DISCOVERY_REFRESH_MS = 60 * 60_000;
/** A previously discovered key set keeps working this long while rediscovery fails. */
const DISCOVERY_MAX_STALE_MS = 24 * 60 * 60_000;
const DISCOVERY_RETRY_MS = 30_000;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type OidcFailureReason = 'invalid' | 'expired' | 'untrusted_issuer' | 'unavailable';

export class OidcVerificationError extends Error {
  constructor(
    readonly reason: OidcFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'OidcVerificationError';
  }
}

export interface VerifiedOidcToken {
  issuer: string;
  /** Every `aud` value; the binding's audience must be the only one. */
  audiences: string[];
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
  claims: GithubClaims;
}

interface Provider {
  keySet: JWTVerifyGetKey;
  discoveredAt: number;
}

export interface OidcVerifierOptions {
  /** Exact issuer URLs from OIDC_TRUSTED_ISSUERS. */
  issuers: readonly string[];
  /** Minimum time between JWKS refetches for unknown key ids. Default 30 s. */
  jwksCooldownMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Verifies OIDC identity tokens from allowlisted issuers (GitHub Actions by
 * default). The issuer is chosen by exact match of the token's `iss` against
 * the allowlist, then everything is verified against that issuer's published
 * discovery document and JWKS: signature, algorithm, issuer, expiry, not
 * before, issued at and lifetime. Claims are only read after verification.
 * Audience is checked by the caller against the matching binding.
 */
export class OidcVerifier {
  private readonly logger = new Logger(OidcVerifier.name);
  private readonly providers = new Map<string, Provider>();
  private readonly failedAt = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: OidcVerifierOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.issuers.length > 0;
  }

  get issuers(): readonly string[] {
    return this.options.issuers;
  }

  async verify(token: string): Promise<VerifiedOidcToken> {
    if (token.length === 0 || token.length > OIDC_LIMITS.maxTokenLength || !JWT_SHAPE.test(token)) {
      throw new OidcVerificationError('invalid', 'Malformed token');
    }
    let unverifiedIssuer: unknown;
    try {
      // Only to pick one of the configured issuers; nothing else is read before verification.
      unverifiedIssuer = decodeJwt(token).iss;
    } catch {
      throw new OidcVerificationError('invalid', 'Malformed token');
    }
    const issuer = this.options.issuers.find((i) => i === unverifiedIssuer);
    if (!issuer) {
      throw new OidcVerificationError('untrusted_issuer', 'The token issuer is not trusted');
    }

    const keySet = await this.keySetFor(issuer);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer,
        algorithms: OIDC_ALGORITHMS,
        clockTolerance: OIDC_LIMITS.clockToleranceSeconds,
        maxTokenAge: OIDC_LIMITS.maxTokenLifetimeSeconds + OIDC_LIMITS.clockToleranceSeconds,
        requiredClaims: ['iat', 'exp', 'nbf', 'jti', 'sub', 'aud'],
        currentDate: new Date(this.now()),
      }));
    } catch (error) {
      throw toVerificationError(error);
    }

    const { iat, exp, jti, aud } = payload;
    if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat <= 0) {
      throw new OidcVerificationError('invalid', 'Token times are invalid');
    }
    if (exp - iat > OIDC_LIMITS.maxTokenLifetimeSeconds) {
      throw new OidcVerificationError('invalid', 'Token lifetime is too long');
    }
    if (typeof jti !== 'string' || jti.length === 0 || jti.length > 256) {
      throw new OidcVerificationError('invalid', 'Token id is invalid');
    }
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (audiences.length === 0 || audiences.some((a) => typeof a !== 'string')) {
      throw new OidcVerificationError('invalid', 'Token audience is invalid');
    }
    const claims = githubClaimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new OidcVerificationError('invalid', 'Token claims are invalid');
    }
    return {
      issuer,
      audiences: audiences as string[],
      jti,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
      claims: claims.data,
    };
  }

  private async keySetFor(issuer: string): Promise<JWTVerifyGetKey> {
    const now = this.now();
    const cached = this.providers.get(issuer);
    if (cached && now - cached.discoveredAt < DISCOVERY_REFRESH_MS) return cached.keySet;
    const lastFailure = this.failedAt.get(issuer);
    const retryAllowed = lastFailure === undefined || now - lastFailure >= DISCOVERY_RETRY_MS;
    if (retryAllowed) {
      try {
        const jwksUri = await this.discover(issuer);
        const keySet = createRemoteJWKSet(jwksUri, {
          timeoutDuration: 3_000,
          cooldownDuration: this.options.jwksCooldownMs ?? 30_000,
          cacheMaxAge: 10 * 60_000,
        });
        this.providers.set(issuer, { keySet, discoveredAt: now });
        this.failedAt.delete(issuer);
        return keySet;
      } catch (error) {
        this.failedAt.set(issuer, now);
        this.logger.warn(
          `OIDC discovery failed for ${issuer}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    if (cached && now - cached.discoveredAt < DISCOVERY_MAX_STALE_MS) return cached.keySet;
    throw new OidcVerificationError('unavailable', 'The identity provider keys are unavailable');
  }

  /** The issuer's `jwks_uri`, which must be on the issuer's own origin. */
  private async discover(issuer: string): Promise<URL> {
    const response = await this.fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`discovery answered ${String(response.status)}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_DISCOVERY_BYTES) throw new Error('discovery document too large');
    const body = await response.text();
    if (body.length > MAX_DISCOVERY_BYTES) throw new Error('discovery document too large');
    const document = JSON.parse(body) as { issuer?: unknown; jwks_uri?: unknown };
    if (document.issuer !== issuer) throw new Error('discovery issuer mismatch');
    if (typeof document.jwks_uri !== 'string') throw new Error('discovery has no jwks_uri');
    const jwksUri = new URL(document.jwks_uri);
    if (jwksUri.origin !== new URL(issuer).origin) throw new Error('jwks_uri on another origin');
    return jwksUri;
  }
}

function toVerificationError(error: unknown): OidcVerificationError {
  if (error instanceof errors.JWTExpired) {
    return new OidcVerificationError('expired', 'Token expired');
  }
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return new OidcVerificationError('unavailable', 'The identity provider keys are unavailable');
  }
  if (error instanceof errors.JOSEError) {
    // Bad signature, unknown kid, wrong algorithm or issuer, not yet valid, too old...
    return new OidcVerificationError('invalid', 'Token is invalid');
  }
  return new OidcVerificationError('unavailable', 'The identity provider keys are unavailable');
}
