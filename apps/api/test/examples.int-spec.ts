import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * The examples in examples/ against this API with a real machine credential
 * and synthetic values. Each must work and must not print values or the
 * credential.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PYTHON = join(ROOT, 'packages/sdk-python/.venv/bin/python');
const CLI = join(ROOT, 'apps/cli/dist/bin.js');
const VALUE = 'synthetic-example-value-9b3a';

let h: Harness;
let apiUrl: string;
let credential = '';
let shims = '';
const running: ChildProcess[] = [];

beforeAll(async () => {
  for (const path of [PYTHON, CLI]) {
    if (!existsSync(path))
      throw new Error(`Missing ${path}: build the CLI and the Python SDK environment`);
  }
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  apiUrl = await h.listen();
  const api = client(h);
  await truncateAllTables(h.db);
  const w = await api.world('examples');
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
  await api.createSecret(w.owner, w.secrets(w.dev), {
    key: 'API_URL',
    value: 'https://api.example.test',
  });
  const base = `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
  const identity = await api.ok(
    api.call(w.owner, 'post', base, { name: 'Examples' }),
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
        name: 'examples',
        scopes: ['environment:read', 'secret:list', 'secret:runtime'],
      }),
      201,
      issuedServiceCredentialSchema,
    )
  ).token;
  shims = await mkdtemp(join(tmpdir(), 'envvault-shims-'));
  await writeFile(join(shims, 'envvault'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  await chmod(join(shims, 'envvault'), 0o755);
}, 120_000);

afterAll(async () => {
  for (const child of running) child.kill('SIGTERM');
  await h.stop();
  if (shims) await rm(shims, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
  return {
    PATH: `${shims}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '',
    ENVVAULT_API_URL: apiUrl,
    ENVVAULT_SERVICE_CREDENTIAL: credential,
    ENVVAULT_ENVIRONMENT: 'development',
    PYTHONPATH: join(ROOT, 'packages/sdk-python/src'),
    ...extra,
  };
}

function start(command: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = spawn(command, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  running.push(child);
  const output = { text: '' };
  child.stdout.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  return { child, output, done };
}

async function until(check: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function clean(text: string) {
  expect(text).not.toContain(VALUE);
  expect(text).not.toContain(credential);
}

async function health(output: { text: string }) {
  await until(() => /Listening on port \d+/.test(output.text));
  const port = /Listening on port (\d+)/.exec(output.text)?.[1] ?? '';
  return (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<
    Record<string, unknown>
  >;
}

describe('examples', () => {
  it('node-backend loads its configuration at startup', async () => {
    const server = start(process.execPath, ['server.mjs'], join(ROOT, 'examples/node-backend'), {
      PORT: '0',
    });
    expect(await health(server.output)).toEqual({ status: 'ok', configured: 2 });
    expect(server.output.text).toContain('Configuration loaded: 2 values from development');
    server.child.kill('SIGTERM');
    await server.done;
    clean(server.output.text);
  });

  it('python-script prints how much it loaded, not what', async () => {
    const script = start(
      PYTHON,
      ['load_config.py', 'development'],
      join(ROOT, 'examples/python-script'),
    );
    expect(await script.done, script.output.text).toBe(0);
    expect(script.output.text).toContain('Configuration loaded: 2');
    clean(script.output.text);
  });

  it('python-service serves health without exposing values', async () => {
    const service = start(PYTHON, ['service.py'], join(ROOT, 'examples/python-service'), {
      PORT: '0',
    });
    expect(await health(service.output)).toEqual({ status: 'ok', configured: 2 });
    service.child.kill('SIGTERM');
    await service.done;
    clean(service.output.text);
  });

  it('ci-generic runs the build with the values and passes exit codes through', async () => {
    const check =
      'process.exit(process.env.API_TOKEN === undefined || process.env.ENVVAULT_SERVICE_CREDENTIAL ? 5 : 0)';
    const ok = start(
      'sh',
      [join(ROOT, 'examples/ci-generic/ci.sh'), process.execPath, '-e', check],
      ROOT,
    );
    expect(await ok.done, ok.output.text).toBe(0);
    clean(ok.output.text);
    const failing = start(
      'sh',
      [join(ROOT, 'examples/ci-generic/ci.sh'), process.execPath, '-e', 'process.exit(9)'],
      ROOT,
    );
    expect(await failing.done).toBe(9);
    const missing = start('sh', [join(ROOT, 'examples/ci-generic/ci.sh'), 'true'], ROOT, {
      ENVVAULT_SERVICE_CREDENTIAL: '',
    });
    expect(await missing.done).toBe(3);
  });
});
