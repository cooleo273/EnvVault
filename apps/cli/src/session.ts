import { EnvVaultApiError, type EnvVaultClient } from '@envvault/sdk';
import type { CliToken } from '@envvault/shared';
import type { Context } from './context.js';
import type { Credential } from './credentials.js';
import { CliError, EXIT } from './errors.js';

/** Refresh this long before the access token expires, so a command never starts with one about to lapse. */
const REFRESH_MARGIN_MS = 60_000;

export function credentialFrom(
  token: CliToken,
  apiUrl: string,
  email: string,
  webUrl: string | undefined,
  now = new Date(),
): Credential {
  return {
    version: 1,
    apiUrl,
    ...(webUrl ? { webUrl } : {}),
    sessionId: token.sessionId,
    email,
    accessToken: token.accessToken,
    accessExpiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    refreshToken: token.refreshToken,
    refreshExpiresAt: token.refreshExpiresAt,
  };
}

export interface Session {
  api: EnvVaultClient;
  apiUrl: string;
  credential: Credential;
}

/**
 * An API client for the signed in user. Refreshes the access token when it
 * is close to expiring (the refresh token rotates and is stored again); a
 * refused refresh removes the stored credentials.
 */
export async function signedIn(ctx: Context): Promise<Session> {
  const apiUrl = await ctx.apiUrl();
  let credential = await ctx.store.read(apiUrl);
  if (!credential)
    throw new CliError(`Not signed in to ${apiUrl}.`, EXIT.auth, 'Run envvault login.');
  const now = Date.now();
  if (Date.parse(credential.refreshExpiresAt) <= now) {
    await ctx.store.remove(apiUrl);
    throw new CliError('Your CLI session expired.', EXIT.auth, 'Run envvault login.');
  }
  if (Date.parse(credential.accessExpiresAt) - REFRESH_MARGIN_MS <= now) {
    credential = await refresh(ctx, credential);
  }
  const current = credential;
  return {
    api: ctx.client(apiUrl, () => Promise.resolve(current.accessToken)),
    apiUrl,
    credential: current,
  };
}

async function refresh(ctx: Context, credential: Credential): Promise<Credential> {
  let token: CliToken;
  try {
    token = await ctx.client(credential.apiUrl).refreshCliSession(credential.refreshToken);
  } catch (error) {
    if (error instanceof EnvVaultApiError && error.statusCode === 401) {
      await ctx.store.remove(credential.apiUrl);
      throw new CliError(
        error.code === 'TOKEN_REVOKED'
          ? 'Your CLI session was ended.'
          : 'Your CLI session expired.',
        EXIT.auth,
        'Run envvault login.',
      );
    }
    throw error;
  }
  const next = credentialFrom(token, credential.apiUrl, credential.email, credential.webUrl);
  await ctx.store.write(next);
  return next;
}
