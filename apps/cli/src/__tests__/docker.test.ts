import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerArguments, dockerBinary, refusedName, selectKeys } from '../commands/docker.js';
import { CliError } from '../errors.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envvault-docker-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('docker arguments', () => {
  it('passes keys by name only, so values never reach the command line', () => {
    expect(dockerArguments('run', ['API_KEY', 'DATABASE_URL'], ['--rm', 'my-image'])).toEqual([
      'run',
      '--env',
      'API_KEY',
      '--env',
      'DATABASE_URL',
      '--rm',
      'my-image',
    ]);
    expect(dockerArguments('compose', ['API_KEY'], ['up', '--build'])).toEqual([
      'compose',
      'up',
      '--build',
    ]);
  });
});

describe('selected keys', () => {
  const loaded = new Map([
    ['API_KEY', 'synthetic'],
    ['DOCKER_HOST', 'tcp://elsewhere:2375'],
    ['PATH', '/evil'],
    ['LD_PRELOAD', '/evil.so'],
  ]);

  it('never passes names that reconfigure Docker or the process', () => {
    expect(selectKeys(loaded, undefined)).toEqual({
      selected: ['API_KEY'],
      refused: ['DOCKER_HOST', 'LD_PRELOAD', 'PATH'],
    });
    for (const name of [
      'DOCKER_CONFIG',
      'COMPOSE_FILE',
      'BUILDKIT_HOST',
      'DYLD_INSERT_LIBRARIES',
      'ENVVAULT_SERVICE_CREDENTIAL',
      'NODE_OPTIONS',
    ]) {
      expect(refusedName(name), name).toBe(true);
    }
    expect(refusedName('DATABASE_URL')).toBe(false);
  });

  it('honours an allowlist and reports missing or invalid names', () => {
    expect(selectKeys(loaded, ['API_KEY']).selected).toEqual(['API_KEY']);
    expect(() => selectKeys(loaded, ['NOPE'])).toThrow(CliError);
    expect(() => selectKeys(loaded, ['bad name'])).toThrow(/Not variable names/);
  });
});

describe('docker binary', () => {
  it('uses docker from PATH by default and validates an explicit path', () => {
    expect(dockerBinary(undefined)).toBe('docker');
    expect(() => dockerBinary('docker')).toThrow(/absolute/);
    expect(() => dockerBinary(join(dir, 'missing'))).toThrow(/not an executable/);
  });

  posixOnly('refuses files that are not executable', async () => {
    const file = join(dir, 'not-executable');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o644);
    expect(() => dockerBinary(file)).toThrow(/not an executable/);
    await chmod(file, 0o755);
    expect(dockerBinary(file)).toBe(file);
  });
});
