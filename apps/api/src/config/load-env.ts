import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv as parseDotenv } from 'node:util';
import { type Env, parseEnv } from './env.js';

/**
 * Local-development convenience: merges values from `.env` files into
 * process.env without overriding variables that are already set. Real
 * deployments inject configuration through the platform instead of files.
 *
 * Precedence: process environment > apps/api/.env > repository root .env
 * Skipped entirely when NODE_ENV=test so tests only see explicit configuration.
 */
export function loadEnvFiles(cwd = process.cwd()): void {
  if (process.env.NODE_ENV === 'test') return;
  for (const file of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
    if (!existsSync(file)) {
      continue;
    }
    const values = parseDotenv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      process.env[key] ??= value;
    }
  }
}

export function loadEnv(): Env {
  loadEnvFiles();
  return parseEnv(process.env);
}
