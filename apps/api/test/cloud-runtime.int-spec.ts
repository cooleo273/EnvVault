import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { issuedServiceCredentialSchema, machineIdentitySummarySchema } from '@envvault/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

/**
 * The cloud runtime workers in examples/ against this API: they start only
 * with configuration, refresh it, and stop once access is revoked, without
 * printing values or the credential.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PYTHON = join(ROOT, 'packages/sdk-python/.venv/bin/python');
const VALUE = 'synthetic-worker-value-8c3b';

let h: Harness;
let api: ReturnType<typeof client>;
let apiUrl = '';
const running: ChildProcess[] = [];

beforeAll(async () => {
  if (!existsSync(PYTHON))
    throw new Error('Create the Python SDK environment first (docs/sdk-python.md)');
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { STEP_UP_RATE_LIMIT: '100' },
    { encryption: { status: 'ready', provider } },
  );
  apiUrl = await h.listen();
  api = client(h);
  await truncateAllTables(h.db);
}, 120_000);

afterAll(async () => {
  for (const child of running) child.kill('SIGTERM');
  await h.stop();
});

async function identityWithCredential(label: string) {
  const w = await api.world(label);
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
  const base = `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
  const identity = await api.ok(
    api.call(w.owner, 'post', base, { name: `${label} worker` }),
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
  const issued = await api.ok(
    api.call(w.owner, 'post', `${base}/${identity.id}/credentials`, {
      name: 'worker',
      scopes: ['environment:read', 'secret:runtime'],
    }),
    201,
    issuedServiceCredentialSchema,
  );
  return {
    token: issued.token,
    revoke: async () => {
      await api.stepUp(w.owner);
      await api.ok(
        api.call(
          w.owner,
          'post',
          `${base}/${identity.id}/credentials/${issued.credential.id}/revoke`,
          {},
        ),
        200,
      );
    },
  };
}

function start(command: string, args: string[], token: string) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ENVVAULT_API_URL: apiUrl,
      ENVVAULT_SERVICE_CREDENTIAL: token,
      ENVVAULT_ENVIRONMENT: 'development',
      REFRESH_SECONDS: '1',
      PYTHONPATH: join(ROOT, 'packages/sdk-python/src'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  const output = { text: '' };
  child.stdout.on('data', (c: Buffer) => (output.text += c.toString()));
  child.stderr.on('data', (c: Buffer) => (output.text += c.toString()));
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  return { output, done };
}

async function until(check: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const loads = (text: string) =>
  text.split('\n').filter((l) => l.startsWith('Configuration loaded: 1 values')).length;

describe('cloud runtime workers', () => {
  for (const [name, command, args] of [
    ['node', process.execPath, [join(ROOT, 'examples/node-worker/worker.mjs')]],
    ['python', PYTHON, [join(ROOT, 'examples/python-worker/worker.py')]],
  ] as const) {
    it(`${name}: refreshes, then stops when the credential is revoked`, async () => {
      const { token, revoke } = await identityWithCredential(`worker-${name}`);
      const worker = start(command, [...args], token);
      await until(() => loads(worker.output.text) >= 2);
      await revoke();
      expect(await worker.done, worker.output.text).toBe(3);
      expect(worker.output.text).toContain('Access to EnvVault ended (CREDENTIAL_REVOKED');
      expect(worker.output.text).not.toContain(VALUE);
      expect(worker.output.text).not.toContain(token);
    }, 60_000);
  }

  it('fails closed at startup without valid configuration', async () => {
    const node = start(
      process.execPath,
      [join(ROOT, 'examples/node-worker/worker.mjs')],
      `evv_sk_${'A'.repeat(16)}_${'b'.repeat(43)}`,
    );
    expect(await node.done).toBe(3);
    expect(node.output.text).toContain('not starting');
  });
});
