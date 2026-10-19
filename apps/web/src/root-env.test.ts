import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWebEnvFromRootFile } from './root-env';

function rootEnvFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'envvault-web-env-')), '.env');
  writeFileSync(
    file,
    [
      'NEON_AUTH_BASE_URL=https://ep-example.neonauth.example/neondb/auth',
      'NEON_AUTH_COOKIE_SECRET=placeholder-secret-with-at-least-32-chars',
      'NEXT_PUBLIC_API_URL=http://localhost:4000',
      'DATABASE_URL=postgresql://user:password@db.example/app',
      'DIRECT_URL=postgresql://user:password@db.example/app',
    ].join('\n'),
  );
  return file;
}

describe('loadWebEnvFromRootFile', () => {
  it('loads only web keys and never backend secrets such as DATABASE_URL', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development' };
    const loaded = loadWebEnvFromRootFile(rootEnvFile(), env);
    expect(loaded.sort()).toEqual([
      'NEON_AUTH_BASE_URL',
      'NEON_AUTH_COOKIE_SECRET',
      'NEXT_PUBLIC_API_URL',
    ]);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DIRECT_URL).toBeUndefined();
  });

  it('never overrides explicitly provided values', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'development',
      NEON_AUTH_BASE_URL: 'http://localhost:4410/neondb/auth',
    };
    loadWebEnvFromRootFile(rootEnvFile(), env);
    expect(env.NEON_AUTH_BASE_URL).toBe('http://localhost:4410/neondb/auth');
  });

  it('is disabled in tests', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'test' };
    expect(loadWebEnvFromRootFile(rootEnvFile(), env)).toEqual([]);
  });
});
