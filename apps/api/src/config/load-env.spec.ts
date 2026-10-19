import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from './load-env.js';

const KEY = 'ENVVAULT_LOAD_ENV_PROBE';

describe('loadEnvFiles', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    Reflect.deleteProperty(process.env, KEY);
  });

  function dirWithEnvFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'envvault-env-'));
    writeFileSync(join(dir, '.env'), `${KEY}=from-file\n`);
    return dir;
  }

  it('never reads .env files in tests (only explicit configuration)', () => {
    process.env.NODE_ENV = 'test';
    loadEnvFiles(dirWithEnvFile());
    expect(process.env[KEY]).toBeUndefined();
  });

  it('fills unset variables in development without overriding real ones', () => {
    process.env.NODE_ENV = 'development';
    loadEnvFiles(dirWithEnvFile());
    expect(process.env[KEY]).toBe('from-file');

    process.env[KEY] = 'from-process';
    loadEnvFiles(dirWithEnvFile());
    expect(process.env[KEY]).toBe('from-process');
  });
});
