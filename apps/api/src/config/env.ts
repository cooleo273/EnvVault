import { isAbsolute } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const originSchema = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);

/** Absolute http(s) URL without a trailing slash. */
const baseUrlSchema = z.url({ protocol: /^https?$/ }).transform((value) => {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
});

function isLocalHost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Comma-separated list of exact browser origins allowed to call the API. */
    CORS_ORIGINS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(originSchema).min(1)),
    RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    /** Per-minute limit for sensitive endpoints (invitation tokens), per client. */
    RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().int().positive().default(20),
    /** Enable only when running behind a trusted reverse proxy / load balancer. */
    TRUST_PROXY: booleanString.default(false),

    /*
     * Neon Auth (managed Better Auth). Each Neon branch has its own Auth URL;
     * development and production MUST point at different branches. Tokens are
     * only accepted from the configured issuer, so a token issued by another
     * branch (e.g. development) is rejected by production.
     */
    /** Auth URL from Neon Console → Auth → Configuration, e.g. https://ep-xxx.neonauth.<region>.aws.neon.tech/neondb/auth */
    NEON_AUTH_BASE_URL: baseUrlSchema,
    /**
     * Optional; defaults to <base>/.well-known/jwks.json. Must share the origin
     * of NEON_AUTH_BASE_URL so keys and issuer always come from the same branch.
     */
    NEON_AUTH_JWKS_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Expected `aud`. Default: origin of NEON_AUTH_BASE_URL (per Neon docs). */
    NEON_AUTH_AUDIENCE: z.string().min(1).optional(),
    /** Neon Auth access tokens live 15 minutes; older tokens are rejected. */
    AUTH_MAX_TOKEN_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
    /** Lifetime of a step-up ("sudo mode") grant after re-verifying credentials. */
    AUTH_STEP_UP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    /**
     * Web app origin registered as a trusted domain in Neon Auth. Sent as the
     * Origin when the API ends the temporary session created during step-up.
     * Default: first CORS origin.
     */
    AUTH_TRUSTED_ORIGIN: originSchema.optional(),
    /**
     * Public origin of the web app, used to build invitation links.
     * Default: first CORS origin.
     */
    APP_BASE_URL: originSchema.optional(),
    /** Lifetime of a workspace invitation (default 7 days, at most 30). */
    INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    /**
     * Outbound email provider. Only `none` exists today: invitations are not
     * emailed and the API says so (`delivery.status = not_configured`).
     */
    EMAIL_PROVIDER: z.enum(['none']).default('none'),

    /*
     * Envelope encryption (see docs/key-management.md). `none` disables secret
     * encryption: nothing can be encrypted and no key is ever generated
     * implicitly. `local` is the self-managed development keyring and is
     * refused in production.
     */
    ENCRYPTION_PROVIDER: z.enum(['none', 'local']).default('none'),
    /** Absolute path of the keyring created by `pnpm crypto:init:dev`. */
    ENCRYPTION_KEYRING_FILE: z.string().min(1).optional(),
    /** Alternative to the file: base64 of the keyring JSON (server-side secret). */
    ENCRYPTION_LOCAL_KEYRING: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // Keys must come from the same Neon Auth branch as the issuer: mixing a
    // JWKS from one branch with another branch's Auth URL is a misconfiguration.
    if (
      env.NEON_AUTH_JWKS_URL !== undefined &&
      new URL(env.NEON_AUTH_JWKS_URL).origin !== new URL(env.NEON_AUTH_BASE_URL).origin
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['NEON_AUTH_JWKS_URL'],
        message: 'must have the same origin as NEON_AUTH_BASE_URL (same Neon Auth branch)',
      });
    }
    const keyringSources = [env.ENCRYPTION_KEYRING_FILE, env.ENCRYPTION_LOCAL_KEYRING].filter(
      (value) => value !== undefined,
    ).length;
    if (env.ENCRYPTION_PROVIDER === 'none' && keyringSources > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_PROVIDER'],
        message: 'must be "local" when a keyring is configured (keys are never ignored silently)',
      });
    }
    if (env.ENCRYPTION_PROVIDER === 'local') {
      if (keyringSources !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENCRYPTION_KEYRING_FILE'],
          message: 'set exactly one of ENCRYPTION_KEYRING_FILE or ENCRYPTION_LOCAL_KEYRING',
        });
      }
      if (env.ENCRYPTION_KEYRING_FILE !== undefined && !isAbsolute(env.ENCRYPTION_KEYRING_FILE)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENCRYPTION_KEYRING_FILE'],
          message: 'must be an absolute path',
        });
      }
      if (env.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['ENCRYPTION_PROVIDER'],
          message:
            'the local key provider is restricted to development and test; production needs a reviewed managed KMS provider',
        });
      }
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    for (const key of ['NEON_AUTH_BASE_URL', 'NEON_AUTH_JWKS_URL'] as const) {
      const value = env[key];
      if (value !== undefined && (!value.startsWith('https://') || isLocalHost(value))) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be a non-local https URL in production',
        });
      }
    }
    if (env.APP_BASE_URL !== undefined && !env.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        message: 'must be an https origin in production',
      });
    }
    if (env.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must only contain https origins in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface NeonAuthSettings {
  baseUrl: string;
  jwksUrl: URL;
  issuer: string;
  audience: string;
  trustedOrigin: string;
}

/** Resolves Neon Auth verification settings, applying Neon's documented defaults. */
export function neonAuthSettings(env: Env): NeonAuthSettings {
  const origin = new URL(env.NEON_AUTH_BASE_URL).origin;
  return {
    baseUrl: env.NEON_AUTH_BASE_URL,
    jwksUrl: new URL(env.NEON_AUTH_JWKS_URL ?? `${env.NEON_AUTH_BASE_URL}/.well-known/jwks.json`),
    // Neon Auth sets `iss` to the origin of the Auth URL; never configurable.
    issuer: origin,
    audience: env.NEON_AUTH_AUDIENCE ?? origin,
    trustedOrigin: env.AUTH_TRUSTED_ORIGIN ?? env.CORS_ORIGINS[0] ?? origin,
  };
}

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates raw environment variables. Error messages reference variable names
 * only and never echo the offending values, which may be secrets.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        const message = issue.code === 'invalid_type' ? 'is required' : issue.message;
        return `${name}: ${message}`;
      }),
    );
  }
  return result.data;
}

/** Origin of the web app (invitation links). */
export function appBaseUrl(env: Env): string {
  return env.APP_BASE_URL ?? env.CORS_ORIGINS[0] ?? 'http://localhost:3000';
}
