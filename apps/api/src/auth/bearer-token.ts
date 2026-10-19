/** RFC 6750 b64token characters. */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

/**
 * Extracts the access token from `Authorization: Bearer <token>`. Tokens are
 * accepted only from this header: never from cookies (no CSRF surface) or the
 * query string (would leak into logs and history).
 */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return BEARER_PATTERN.exec(header)?.[1] ?? null;
}
