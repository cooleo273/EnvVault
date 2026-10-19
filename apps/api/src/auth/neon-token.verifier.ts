import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/**
 * Identity asserted by a Neon Auth access token whose signature and claims
 * have been verified. This is authentication only: it says who the caller is,
 * never what they may do.
 */
export interface VerifiedToken {
  /** Neon Auth user id (`sub`, equal to `neon_auth.user.id`). */
  authUserId: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
  banned: boolean;
  issuedAt: Date;
  expiresAt: Date;
}

export type TokenFailureReason = 'expired' | 'invalid' | 'unavailable';

export class TokenVerificationError extends Error {
  constructor(
    readonly reason: TokenFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface NeonTokenVerifierOptions {
  jwksUrl: URL;
  /** Expected `iss`: the origin of the Neon Auth URL. */
  issuer: string;
  /** Expected `aud`: the origin of the Neon Auth URL. */
  audience: string;
  maxTokenAgeSeconds: number;
  clockToleranceSeconds: number;
  /** Minimum time between JWKS re-fetches triggered by unknown `kid`s. Default 30 s. */
  jwksCooldownMs?: number;
  /** Test seam: replaces the remote JWKS. */
  keySet?: JWTVerifyGetKey;
}

/** Neon Auth signs with EdDSA (Ed25519). Any other `alg` is rejected outright. */
export const NEON_AUTH_ALGORITHMS = ['EdDSA'];

/** Neon Auth user ids are UUIDs; accept only conservative identifier characters. */
const SUBJECT_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

const MAX_TOKEN_LENGTH = 8192;

const claimsSchema = z.object({
  sub: z.string().regex(SUBJECT_PATTERN),
  /** Neon includes the user id twice; when present it must agree with `sub`. */
  id: z.string().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  email: z.email().max(320),
  emailVerified: z.boolean().optional(),
  name: z.string().max(200).nullish(),
  banned: z.boolean().nullish(),
});

/**
 * Verifies Neon Auth access tokens against the branch's JWKS, following
 * https://neon.com/docs/auth/guides/plugins/jwt :
 *
 * - signature with the key named by `kid` from `<auth-url>/.well-known/jwks.json`
 * - `alg` must be EdDSA; `iss` and `aud` must equal the Auth URL origin
 * - `exp`, `iat` required; tokens older than the configured max age rejected
 *
 * Key rotation: jose caches the JWKS and re-fetches it when a token names an
 * unknown `kid` (rate-limited by `cooldownDuration`) or the cache is older
 * than `cacheMaxAge`, so rotated keys are picked up without a restart.
 */
export class NeonTokenVerifier {
  private readonly keySet: JWTVerifyGetKey;

  constructor(private readonly options: NeonTokenVerifierOptions) {
    this.keySet =
      options.keySet ??
      createRemoteJWKSet(options.jwksUrl, {
        timeoutDuration: 3_000,
        cooldownDuration: options.jwksCooldownMs ?? 30_000,
        cacheMaxAge: 10 * 60_000,
      });
  }

  async verify(token: string): Promise<VerifiedToken> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new TokenVerificationError('invalid', 'Malformed token');
    }

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.keySet, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: NEON_AUTH_ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds,
        maxTokenAge: this.options.maxTokenAgeSeconds + this.options.clockToleranceSeconds,
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch (error) {
      throw toVerificationError(error);
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new TokenVerificationError('invalid', 'Token claims are invalid');
    }
    const { sub, id, iat, exp, email, emailVerified, name, banned } = claims.data;
    if (id !== undefined && id !== sub) {
      throw new TokenVerificationError('invalid', 'Token subject mismatch');
    }

    return {
      authUserId: sub,
      email: email.toLowerCase(),
      emailVerified: emailVerified === true,
      name: name ?? undefined,
      banned: banned === true,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
    };
  }
}

function toVerificationError(error: unknown): TokenVerificationError {
  if (error instanceof errors.JWTExpired) {
    return new TokenVerificationError('expired', 'Token expired');
  }
  // The key set could not be fetched: we cannot decide, so fail closed with 503.
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return new TokenVerificationError('unavailable', 'Identity provider keys unavailable');
  }
  if (error instanceof errors.JOSEError) {
    // Bad signature, wrong iss/aud/alg, unknown kid, malformed token, too old...
    return new TokenVerificationError('invalid', 'Token is invalid');
  }
  // Network failures while fetching the JWKS surface as non-JOSE errors.
  return new TokenVerificationError('unavailable', 'Identity provider keys unavailable');
}
