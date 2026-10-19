import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Keys the web app may take from the monorepo's root `.env`. Backend secrets
 * that live in the same file (DATABASE_URL, DIRECT_URL, ...) are never loaded
 * into the web server's environment.
 */
export const WEB_ENV_KEYS = [
  'NEON_AUTH_BASE_URL',
  'NEON_AUTH_COOKIE_SECRET',
  'APP_BASE_URL',
  'API_INTERNAL_URL',
] as const;

/**
 * Local-development convenience: copies allow-listed keys (and NEXT_PUBLIC_*)
 * from the root `.env` into `process.env` without overriding variables that
 * are already set. Skipped in tests. Deployments inject configuration directly.
 */
export function loadWebEnvFromRootFile(
  file: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.NODE_ENV === 'test' || !existsSync(file)) return [];
  const values = parseEnv(readFileSync(file, 'utf8'));
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const allowed =
      (WEB_ENV_KEYS as readonly string[]).includes(key) || key.startsWith('NEXT_PUBLIC_');
    if (allowed && env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
