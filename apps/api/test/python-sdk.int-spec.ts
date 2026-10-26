import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { issuedServiceCredentialSchema, machineIdentitySummarySchema } from '@envvault/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

/**
 * Runs the Python SDK's integration tests (packages/sdk-python/tests/integration)
 * against this API on a loopback port, with synthetic data and credentials
 * prepared here. Needs the SDK's virtual environment (docs/sdk-python.md).
 */
const SDK_DIR = fileURLToPath(new URL('../../../packages/sdk-python', import.meta.url));
const PYTHON = `${SDK_DIR}/.venv/bin/python`;
const VALUE = 'synthetic-python-live-value-2c7d';

let h: Harness;
let api: ReturnType<typeof client>;
let apiUrl: string;

beforeAll(async () => {
  if (!existsSync(PYTHON)) {
    throw new Error(
      'Create the Python SDK environment first: cd packages/sdk-python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"',
    );
  }
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  apiUrl = await h.listen();
  api = client(h);
  await truncateAllTables(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

function pytest(env: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(PYTHON, ['-m', 'pytest', 'tests/integration', '-p', 'no:cacheprovider'], {
      cwd: SDK_DIR,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('close', (code) => {
      resolve({ code, output });
    });
  });
}

describe('Python SDK against the API', () => {
  it('passes its live integration tests', async () => {
    const w = await api.world('python-sdk');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
    const base = `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
    const identity = await api.ok(
      api.call(w.owner, 'post', base, { name: 'Python worker' }),
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
    const issue = async (name: string, scopes: string[]) =>
      api.ok(
        api.call(w.owner, 'post', `${base}/${identity.id}/credentials`, { name, scopes }),
        201,
        issuedServiceCredentialSchema,
      );
    const all = ['environment:read', 'secret:list', 'secret:runtime'];
    const valid = await issue('valid', all);
    const revoked = await issue('revoked', all);
    const expired = await issue('expired', all);
    const narrow = await issue('narrow', ['environment:read']);
    await api.ok(
      api.call(
        w.owner,
        'post',
        `${base}/${identity.id}/credentials/${revoked.credential.id}/revoke`,
        {},
      ),
      200,
    );
    await h.db.serviceCredential.update({
      where: { id: expired.credential.id },
      data: { expiresAt: new Date(Date.now() + 1000) },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const result = await pytest({
      ENVVAULT_IT_REQUIRED: '1',
      ENVVAULT_IT_API_URL: apiUrl,
      ENVVAULT_IT_CREDENTIAL: valid.token,
      ENVVAULT_IT_REVOKED: revoked.token,
      ENVVAULT_IT_EXPIRED: expired.token,
      ENVVAULT_IT_NARROW: narrow.token,
      ENVVAULT_IT_PROJECT: w.project,
      ENVVAULT_IT_PROTECTED: w.prod,
      ENVVAULT_IT_DIGEST: createHash('sha256').update(VALUE).digest('hex'),
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/5 passed/);
    expect(result.output).not.toContain('skipped');
    expect(result.output).not.toContain(VALUE);
    expect(result.output).not.toContain(valid.token);
    const loads = await h.db.auditEvent.count({
      where: { action: 'secret.runtime_loaded', actorServiceIdentityId: identity.id },
    });
    expect(loads).toBeGreaterThanOrEqual(3);
  });
});
