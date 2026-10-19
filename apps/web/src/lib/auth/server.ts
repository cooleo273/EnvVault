import 'server-only';
import { createNeonAuth, type NeonAuth } from '@neondatabase/auth/next/server';
import { serverEnv } from '@/server-env';

let instance: NeonAuth | undefined;

/**
 * Server-side Neon Auth instance (official `@neondatabase/auth` Next.js SDK).
 * Created lazily so builds and tests do not require auth configuration.
 *
 * Sessions: Neon Auth keeps an opaque session token in an HTTP-only cookie,
 * plus a signed `session_data` cache cookie (HMAC with NEON_AUTH_COOKIE_SECRET,
 * TTL 300 s). The browser never receives JWTs; the server mints short-lived
 * access tokens on demand for calls to the EnvVault API.
 */
export function getAuth(): NeonAuth {
  if (!instance) {
    const env = serverEnv();
    instance = createNeonAuth({
      baseUrl: env.NEON_AUTH_BASE_URL,
      cookies: {
        secret: env.NEON_AUTH_COOKIE_SECRET,
        // Keep the documented default: cookies are never sent cross-site.
        sameSite: 'strict',
      },
      // Neon's server logs never include credentials; keep warnings visible.
      logLevel: env.NODE_ENV === 'test' ? 'silent' : 'warn',
    });
  }
  return instance;
}
