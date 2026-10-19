import { z } from 'zod';

/**
 * Server-only configuration for authentication and the backend-for-frontend.
 * Never import from client components: these values include secrets.
 *
 * Development and production must use different Neon Auth branches (each
 * branch has its own Auth URL, users and sessions) and different cookie
 * secrets.
 */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Neon Console → Auth → Configuration → Auth URL for THIS environment's branch. */
    NEON_AUTH_BASE_URL: z.url({ protocol: /^https?$/ }),
    /** Signs the session-data cookie (HMAC-SHA256). `openssl rand -base64 32`. */
    NEON_AUTH_COOKIE_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /** Public origin of this web app; used in password-reset links (must be a Neon trusted domain). */
    APP_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .default('http://localhost:3000')
      .transform((value) => new URL(value).origin),
    /** EnvVault API origin reachable from the Next.js server. Default: NEXT_PUBLIC_API_URL. */
    API_INTERNAL_URL: z
      .url({ protocol: /^https?$/ })
      .optional()
      .transform((value) => (value ? new URL(value).origin : undefined)),
    NEXT_PUBLIC_API_URL: z
      .url({ protocol: /^https?$/ })
      .default('http://localhost:4000')
      .transform((value) => new URL(value).origin),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['NEON_AUTH_BASE_URL', 'APP_BASE_URL'] as const) {
      const { protocol, hostname } = new URL(env[key]);
      if (protocol !== 'https:' || hostname === 'localhost' || hostname === '127.0.0.1') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be a non-local https URL in production',
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Validates server configuration. Messages name variables, never their values. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `${name}: ${issue.code === 'invalid_type' ? 'is required' : issue.message}`;
    });
    throw new Error(`Invalid web server configuration:\n  - ${issues.join('\n  - ')}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Lazily parsed so builds and tests do not need auth secrets. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
