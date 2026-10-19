import 'server-only';
import { createEnvVaultClient, EnvVaultApiError, type EnvVaultClient } from '@envvault/sdk';
import { getAuth } from '@/lib/auth/server';
import { serverEnv } from '@/server-env';

/**
 * Mints a fresh Neon Auth access token (EdDSA JWT, 15 min) for the current
 * session via the official SDK (`GET <auth-url>/token`). Tokens stay on the
 * server: they are sent to the EnvVault API and never to the browser.
 */
async function mintAccessToken(): Promise<string | null> {
  const { data, error } = await getAuth().token();
  if (error) return null;
  return data.token || null;
}

function client(): EnvVaultClient {
  const env = serverEnv();
  return createEnvVaultClient({
    baseUrl: env.API_INTERNAL_URL ?? env.NEXT_PUBLIC_API_URL,
    getAccessToken: mintAccessToken,
    timeoutMs: 8_000,
  });
}

/**
 * Backend-for-frontend call to the EnvVault API with the current user's token.
 *
 * Logout revokes tokens issued before it at one-second granularity (JWT
 * `iat`), so a token minted in the same second as a logout on another device
 * can be rejected with TOKEN_REVOKED. Such a call is retried once with a
 * newly minted token after the boundary has passed.
 */
export async function withApi<T>(call: (api: EnvVaultClient) => Promise<T>): Promise<T> {
  try {
    return await call(client());
  } catch (error) {
    if (error instanceof EnvVaultApiError && error.code === 'TOKEN_REVOKED') {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      return call(client());
    }
    throw error;
  }
}

export function isApiError(error: unknown, code?: string): error is EnvVaultApiError {
  return error instanceof EnvVaultApiError && (code === undefined || error.code === code);
}

/**
 * A client bound to a token minted now. Use when the Neon Auth session
 * changes later in the same request (e.g. a password change replaces the
 * session cookie): minting afterwards would read the old, revoked cookie.
 * Returns null when no session is active.
 */
export async function clientWithCurrentToken(): Promise<EnvVaultClient | null> {
  const token = await mintAccessToken();
  if (!token) return null;
  const env = serverEnv();
  return createEnvVaultClient({
    baseUrl: env.API_INTERNAL_URL ?? env.NEXT_PUBLIC_API_URL,
    getAccessToken: () => Promise.resolve(token),
    timeoutMs: 8_000,
  });
}
