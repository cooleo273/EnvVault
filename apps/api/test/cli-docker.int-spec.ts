import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { issuedServiceCredentialSchema, machineIdentitySummarySchema } from '@envvault/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

/**
 * `envvault docker run|compose` from the built CLI against this API, with a
 * fake docker executable that records its arguments and which variables it
 * received (never their values). Real Docker is not needed.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'apps/cli/dist/bin.js');
const VALUE = 'synthetic-docker-value-5e2a';
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let h: Harness;
let apiUrl = '';
let credential = '';
let dir = '';

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('Build the CLI first: pnpm --filter @envvault/cli build');
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  apiUrl = await h.listen();
  const api = client(h);
  await truncateAllTables(h.db);
  const w = await api.world('docker');
  for (const [key, value] of Object.entries({
    API_TOKEN: VALUE,
    DOCKER_HOST: 'tcp://attacker.test:2375',
    LOG_LEVEL: 'debug',
  })) {
    await api.createSecret(w.owner, w.secrets(w.dev), { key, value });
  }
  const base = `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
  const identity = await api.ok(
    api.call(w.owner, 'post', base, { name: 'Docker host' }),
    201,
    machineIdentitySummarySchema,
  );
  await api.stepUp(w.owner);
  await api.ok(
    api.call(w.owner, 'post', `${base}/${identity.id}/grants`, {
      environmentId: w.dev,
      roleKey: 'environment-runtime',
    }),
    201,
  );
  credential = (
    await api.ok(
      api.call(w.owner, 'post', `${base}/${identity.id}/credentials`, {
        name: 'docker',
        scopes: ['environment:read', 'secret:runtime'],
      }),
      201,
      issuedServiceCredentialSchema,
    )
  ).token;
  dir = await mkdtemp(join(tmpdir(), 'envvault-docker-'));
  // Records arguments and, for each variable, only whether it arrived with the expected value.
  await writeFile(
    join(dir, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
{
  [ "$API_TOKEN" = "${VALUE}" ] && echo API_TOKEN=match
  [ -n "$DOCKER_HOST" ] && echo DOCKER_HOST=set
  [ -n "$ENVVAULT_SERVICE_CREDENTIAL" ] && echo CREDENTIAL=set
  [ -n "$LOG_LEVEL" ] && echo LOG_LEVEL=set
} > "${dir}/env"
exit 7
`,
  );
  await chmod(join(dir, 'docker'), 0o755);
}, 120_000);

afterAll(async () => {
  await h.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function cli(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        ENVVAULT_API_URL: apiUrl,
        ENVVAULT_SERVICE_CREDENTIAL: credential,
      },
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    child.once('close', (code) => {
      resolve({ code, output });
    });
  });
}

posixOnly('envvault docker', () => {
  it('runs docker with variables by name, values only in its environment, and passes the exit code', async () => {
    const run = await cli([
      'docker',
      'run',
      '--env',
      'development',
      '--docker',
      join(dir, 'docker'),
      '--',
      '--rm',
      'my-image',
    ]);
    expect(run.code, run.output).toBe(7);
    const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n');
    expect(args).toEqual(['run', '--env', 'API_TOKEN', '--env', 'LOG_LEVEL', '--rm', 'my-image']);
    const env = (await readFile(join(dir, 'env'), 'utf8')).trim().split('\n').sort();
    // DOCKER_HOST from EnvVault is never passed: it would send the values to another daemon.
    expect(env).toEqual(['API_TOKEN=match', 'LOG_LEVEL=set']);
    expect(run.output).toContain('Not passed (they would reconfigure Docker itself): DOCKER_HOST');
    expect(run.output).toContain('docker inspect');
    expect(run.output).not.toContain(VALUE);
    expect(run.output).not.toContain(credential);
  });

  it('passes only listed keys to docker compose', async () => {
    const run = await cli([
      'docker',
      'compose',
      '--env',
      'development',
      '--keys',
      'API_TOKEN',
      '--docker',
      join(dir, 'docker'),
      '--',
      'up',
      '--build',
    ]);
    expect(run.code).toBe(7);
    expect((await readFile(join(dir, 'args'), 'utf8')).trim().split('\n')).toEqual([
      'compose',
      'up',
      '--build',
    ]);
    expect((await readFile(join(dir, 'env'), 'utf8')).trim()).toBe('API_TOKEN=match');
  });

  it('refuses a relative docker path and unknown keys before loading anything', async () => {
    expect((await cli(['docker', 'run', '--docker', 'docker', '--', 'img'])).code).toBe(2);
    const missing = await cli([
      'docker',
      'run',
      '--env',
      'development',
      '--keys',
      'NOPE',
      '--docker',
      join(dir, 'docker'),
      '--',
      'img',
    ]);
    expect(missing.code).toBe(6);
  });
});
