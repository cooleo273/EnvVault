import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  issuedServiceCredentialSchema,
  machineIdentitySummarySchema,
  oidcTrustBindingSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';
import { DEFAULT_CLAIMS, OidcIssuer } from './support/oidc-issuer.js';
import { client } from './support/secrets-world.js';

/**
 * The bundled GitHub Action (packages/github-action/dist) run as a GitHub
 * runner runs it: inputs as INPUT_* variables, GITHUB_OUTPUT and RUNNER_TEMP
 * files, and the runner's OIDC endpoint, served here by the local issuer.
 * Real API, real PostgreSQL, synthetic values.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ACTION = join(ROOT, 'packages/github-action/dist/index.mjs');
const VALUE = 'synthetic-action-secret-6d2f';
const PEM =
  '-----BEGIN SYNTHETIC KEY-----\nc3ludGhldGljLWxpbmUtb25l\nc3ludGhldGljLWxpbmUtdHdv\n-----END SYNTHETIC KEY-----';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

let h: Harness;
let api: ReturnType<typeof client>;
let issuer: OidcIssuer;
let apiUrl: string;
let scratch: string;

beforeAll(async () => {
  if (!existsSync(ACTION))
    throw new Error('Build the action first: pnpm --filter @envvault/github-action build');
  issuer = await OidcIssuer.start();
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { OIDC_TRUSTED_ISSUERS: issuer.url, STEP_UP_RATE_LIMIT: '100' },
    { encryption: { status: 'ready', provider } },
  );
  apiUrl = await h.listen();
  api = client(h);
}, 120_000);
afterAll(async () => {
  await h.stop();
  await issuer.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
  issuer.runnerClaims = {};
  issuer.runnerAudiences.length = 0;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = await mkdtemp(join(tmpdir(), 'envvault-action-'));
});

async function world(values: Record<string, string> = { API_TOKEN: VALUE }) {
  const w = await api.world('action');
  const lead = h.newUser('action-lead');
  const membership = await api.addToProject(w, lead, 'project-admin');
  await api.grant(w, w.prod, membership, 'environment-writer');
  for (const [key, value] of Object.entries(values)) {
    await api.createSecret(lead, w.secrets(w.dev), { key, value });
  }
  const base = `/workspaces/${w.ws}/projects/${w.project}`;
  const identity = await api.ok(
    api.call(lead, 'post', `${base}/machine-identities`, { name: 'GitHub build' }),
    201,
    machineIdentitySummarySchema,
  );
  await api.stepUp(lead);
  await api.ok(
    api.call(lead, 'post', `${base}/machine-identities/${identity.id}/grants`, {
      environmentId: w.dev,
      roleKey: 'environment-runtime',
    }),
    201,
  );
  await api.stepUp(lead);
  const binding = await api.ok(
    api.call(lead, 'post', `${base}/oidc-trust-bindings`, {
      identityId: identity.id,
      name: 'Build on main',
      issuer: issuer.url,
      audience: apiUrl,
      repositoryId: DEFAULT_CLAIMS.repository_id,
      repositoryOwnerId: DEFAULT_CLAIMS.repository_owner_id,
      repositoryName: DEFAULT_CLAIMS.repository,
      refs: ['refs/heads/main'],
      eventNames: ['push'],
      environmentIds: [w.dev],
    }),
    201,
    oidcTrustBindingSchema,
  );
  return { w, lead, identity, binding, base };
}

interface ActionRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outputs: string;
}

async function action(
  inputs: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<ActionRun> {
  const outputFile = join(scratch, 'github_output');
  await writeFile(outputFile, '');
  const runnerTemp = join(scratch, 'runner_temp');
  const tmp = join(scratch, 'tmp');
  await Promise.all([mkdir(runnerTemp, { recursive: true }), mkdir(tmp, { recursive: true })]);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: scratch,
    TMPDIR: tmp,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outputFile,
    GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: issuer.runnerUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: issuer.requestToken,
    ...extraEnv,
  };
  for (const [name, value] of Object.entries({
    'api-url': apiUrl,
    environment: 'Development',
    ...inputs,
  })) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACTION], {
      env,
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('close', (code) => {
      void readFile(outputFile, 'utf8').then((outputs) => {
        resolve({ code, stdout, stderr, outputs });
      });
    });
  });
}

/** Lines that are not mask commands must not contain the value (the runner hides mask lines). */
function unmasked(run: ActionRun, value: string): string[] {
  return `${run.stdout}\n${run.stderr}`
    .split('\n')
    .filter((line) => !line.startsWith('::add-mask::'))
    .filter((line) => line.includes(value));
}

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(needle)) found.push(path);
  }
  return found;
}

const node = (script: string) => `${process.execPath} -e ${JSON.stringify(script)}`;

describe('GitHub Action against the local API', () => {
  it('runs the command with the values, masked first, and leaves nothing behind', async () => {
    const { binding, identity } = await world({
      API_TOKEN: VALUE,
      SIGNING_KEY: PEM,
      EMPTY_FLAG: '',
    });
    const run = await action({
      command: node(
        `const c=require('crypto');const h=v=>c.createHash('sha256').update(v).digest('hex');` +
          `console.log('child', h(process.env.API_TOKEN), h(process.env.SIGNING_KEY), JSON.stringify(process.env.EMPTY_FLAG),` +
          ` 'runnerTokenVisible=' + Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN), 'inputVisible=' + Boolean(process.env['INPUT_API-URL']))`,
      ),
    });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const childLine = run.stdout.split('\n').find((l) => l.startsWith('child ')) ?? '';
    expect(childLine).toBe(
      `child ${sha(VALUE)} ${sha(PEM)} "" runnerTokenVisible=false inputVisible=false`,
    );

    // Masks precede the command's output: the value, each PEM line, the JSON form.
    const firstChildLine = run.stdout.indexOf('child ');
    for (const mask of [VALUE, 'c3ludGhldGljLWxpbmUtb25l', '-----END SYNTHETIC KEY-----']) {
      const at = run.stdout.indexOf(`::add-mask::${mask}`);
      expect(at, mask).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstChildLine);
    }
    expect(unmasked(run, VALUE)).toEqual([]);
    expect(unmasked(run, 'c3ludGhldGljLWxpbmUtdHdv')).toEqual([]);
    expect(run.outputs).toContain('variables-loaded');
    expect(run.outputs).toContain('exit-code');
    expect(run.outputs).not.toContain(VALUE);
    expect(await filesContaining(scratch, VALUE)).toEqual([]);
    // The identity token was single use and the access token was ended after loading.
    expect(issuer.runnerAudiences).toEqual([apiUrl]);
    const tokens = await h.db.machineAccessToken.findMany({ where: { credentialId: binding.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revokedAt).not.toBeNull();
    const loads = await h.db.auditEvent.count({
      where: { action: 'secret.runtime_loaded', actorServiceIdentityId: identity.id },
    });
    expect(loads).toBe(1);
  });

  it('passes the exit status through and keeps failures free of values', async () => {
    await world();
    const run = await action({
      command: node(`process.stderr.write('failing\\n'); process.exit(5)`),
    });
    expect(run.code).toBe(5);
    expect(run.stdout).toContain('::error::The command exited with status 5');
    expect(unmasked(run, VALUE)).toEqual([]);
    const missing = await action({ command: 'definitely-not-installed-xyz --flag' });
    expect(missing.code).toBe(127);
    expect(missing.stdout).toContain('definitely-not-installed-xyz was not found');
  });

  it('refuses reserved names before running anything', async () => {
    await world({ API_TOKEN: VALUE, NODE_OPTIONS: '--require=/tmp/evil.js' });
    const marker = join(scratch, 'ran');
    const run = await action({
      command: node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('NODE_OPTIONS is reserved');
    expect(existsSync(marker)).toBe(false);
  });

  it('cannot reach environments outside the binding', async () => {
    await world();
    const run = await action({ environment: 'Production', command: node('process.exit(0)') });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/::error::EnvVault refused the request: NOT_FOUND/);
  });

  it('is refused for an untrusted workflow, and explains a missing id-token permission', async () => {
    await world();
    issuer.runnerClaims = { event_name: 'pull_request', ref: 'refs/pull/9/merge' };
    const untrusted = await action({ command: node('process.exit(0)') });
    expect(untrusted.code).toBe(1);
    expect(untrusted.stdout).toContain('OIDC_NO_MATCHING_BINDING');

    issuer.runnerClaims = {};
    const noPermission = await action(
      { command: node('process.exit(0)') },
      { ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
    );
    expect(noPermission.code).toBe(1);
    expect(noPermission.stdout).toContain('id-token: write');
  });

  it('uses a service credential only when asked, and reports an expired one', async () => {
    const { lead, identity, base } = await world();
    await api.stepUp(lead);
    const issued = await api.ok(
      api.call(lead, 'post', `${base}/machine-identities/${identity.id}/credentials`, {
        name: 'fallback',
        scopes: ['environment:read', 'secret:runtime'],
        expiresInDays: 1,
      }),
      201,
      issuedServiceCredentialSchema,
    );
    const run = await action({
      'auth-mode': 'service-credential',
      'service-credential': issued.token,
      command: node(`process.exit(process.env.API_TOKEN ? 0 : 9)`),
    });
    expect(run.code, run.stdout).toBe(0);
    expect(issuer.runnerAudiences).toEqual([]);
    expect(unmasked(run, issued.token)).toEqual([]);

    await h.db.serviceCredential.update({
      where: { id: issued.credential.id },
      data: { expiresAt: new Date(Date.now() + 500) },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const expired = await action({
      'auth-mode': 'service-credential',
      'service-credential': issued.token,
      command: node('process.exit(0)'),
    });
    expect(expired.code).toBe(1);
    expect(expired.stdout).toContain('CREDENTIAL_EXPIRED');
    expect(unmasked(expired, issued.token)).toEqual([]);
  });

  it('reports an unreachable API without retrying the exchange', async () => {
    await world();
    const run = await action({ 'api-url': 'http://127.0.0.1:9', command: node('process.exit(0)') });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('could not be reached');
  });
});
