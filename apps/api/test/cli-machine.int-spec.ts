import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * The built CLI in machine mode, as a CI job would run it: a service
 * credential in ENVVAULT_SERVICE_CREDENTIAL (or a file, or stdin), no
 * sign in, no stored credentials. Synthetic values only.
 */
const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const VALUE = 'synthetic-ci-value-5d0e';
const DIGEST = createHash('sha256').update(VALUE).digest('hex');
const posixOnly = process.platform === 'win32' ? it.skip : it;

let h: Harness;
let api: ReturnType<typeof client>;
let apiUrl: string;
let home: string;
let project: string;
let credential: string;
let credentialId: string;
let identityId: string;
let w: Awaited<ReturnType<ReturnType<typeof client>['world']>>;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function envvault(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: project,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      ENVVAULT_CONFIG_DIR: join(home, 'config'),
      ENVVAULT_CREDENTIAL_STORE: 'file',
      ENVVAULT_API_URL: apiUrl,
      NO_COLOR: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result: Result = { code: null, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => (result.stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (result.stderr += chunk.toString()));
  child.stdin.end(stdin ?? '');
  return new Promise<Result>((resolve) => {
    child.once('close', (code) => {
      result.code = code;
      resolve(result);
    });
  });
}

const ci = (args: string[], extra: Record<string, string> = {}) =>
  envvault(args, { ENVVAULT_SERVICE_CREDENTIAL: credential, ...extra });

function expectClean(result: Result) {
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(VALUE);
  expect(output).not.toContain(credential);
  expect(output).not.toMatch(/evv_(sk|mt)_[A-Za-z0-9]{16}/);
}

const base = () => `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error('Build the CLI first: pnpm --filter @envvault/cli build');
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  apiUrl = await h.listen();
  api = client(h);
  await truncateAllTables(h.db);
  home = await mkdtemp(join(tmpdir(), 'envvault-ci-home-'));
  project = await mkdtemp(join(tmpdir(), 'envvault-ci-project-'));
  await writeFile(
    join(project, 'check.mjs'),
    [
      "import { createHash } from 'node:crypto';",
      "const digest = createHash('sha256').update(process.env.API_TOKEN ?? '').digest('hex');",
      "console.log(digest === process.argv[2] ? 'match' : 'mismatch');",
      "console.log(process.env.ENVVAULT_SERVICE_CREDENTIAL === undefined ? 'no credential' : 'credential leaked');",
    ].join('\n'),
  );

  w = await api.world('cli-machine');
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
  const identity = await api.ok(
    api.call(w.owner, 'post', base(), { name: 'Staging Build Server' }),
    201,
    machineIdentitySummarySchema,
  );
  identityId = identity.id;
  await api.stepUp(w.owner);
  await api.ok(
    api.call(w.owner, 'post', `${base()}/${identityId}/grants`, {
      environmentId: w.dev,
      roleKey: 'environment-runtime',
    }),
    201,
  );
  const issued = await api.ok(
    api.call(w.owner, 'post', `${base()}/${identityId}/credentials`, {
      name: 'build',
      scopes: ['environment:read', 'secret:list', 'secret:runtime'],
    }),
    201,
    issuedServiceCredentialSchema,
  );
  credential = issued.token;
  credentialId = issued.credential.id;
}, 120_000);

afterAll(async () => {
  await h.stop();
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('envvault with a service credential', () => {
  it('checks the credential and shows what it may do, printing no token', async () => {
    const result = await ci(['auth', 'service', '--from-env']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Staging Build Server');
    expect(result.stdout).toContain('Development (run, list, read)');
    expectClean(result);
    const json = await ci(['whoami', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ kind: 'machine', identityId });
    // Nothing is stored for a machine.
    expect(existsSync(join(home, 'config', 'credentials.json'))).toBe(false);
  });

  it('injects values into the child, never the credential, and ends its token', async () => {
    const result = await ci([
      'run',
      '--env',
      'development',
      '--',
      process.execPath,
      'check.mjs',
      DIGEST,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split('\n')).toEqual(['match', 'no credential', '']);
    expectClean(result);
    const live = await h.db.machineAccessToken.count({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(live).toBe(0);
    expect(
      await h.db.auditEvent.count({
        where: { action: 'secret.runtime_loaded', actorServiceIdentityId: identityId },
      }),
    ).toBe(1);
  });

  it('forwards exit codes and refuses ungranted environments', async () => {
    expect(
      (await ci(['run', '--env', 'development', '--', process.execPath, '-e', 'process.exit(9)']))
        .code,
    ).toBe(9);
    const prod = await ci(['run', '--env', 'production', '--', process.execPath, '-e', '0']);
    expect(prod.code).toBe(6);
    expectClean(prod);
  });

  posixOnly('reads a credential file only its owner can read, or standard input', async () => {
    const path = join(home, 'credential');
    await writeFile(path, `${credential}\n`, { mode: 0o600 });
    const fromFile = await envvault(['auth', 'service', '--from-file', path]);
    expect(fromFile.code, fromFile.stderr).toBe(0);
    const viaEnv = await envvault(['env', 'list', '--json'], {
      ENVVAULT_SERVICE_CREDENTIAL_FILE: path,
    });
    expect((JSON.parse(viaEnv.stdout) as { slug: string }[]).map((e) => e.slug)).toEqual([
      'development',
    ]);
    await chmod(path, 0o644);
    expect((await envvault(['auth', 'service', '--from-file', path])).code).toBe(3);
    const fromStdin = await envvault(['auth', 'service', '--from-stdin'], {}, `${credential}\n`);
    expect(fromStdin.code, fromStdin.stderr).toBe(0);
    expectClean(fromStdin);
  });

  it('refuses person commands, file exports and a link to another project', async () => {
    expect((await ci(['login', '--no-browser'])).code).toBe(2);
    expect((await ci(['pull'])).code).toBe(5);
    await writeFile(
      join(project, '.envvault.json'),
      JSON.stringify({
        version: 1,
        workspaceId: w.ws,
        projectId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c99',
      }),
    );
    expect(
      (await ci(['run', '--env', 'development', '--', process.execPath, '-e', '0'])).code,
    ).toBe(3);
    await writeFile(
      join(project, '.envvault.json'),
      JSON.stringify({ version: 1, workspaceId: w.ws, projectId: w.project, environmentId: w.dev }),
    );
    const linked = await ci(['run', '--', process.execPath, 'check.mjs', DIGEST]);
    expect(linked.stdout.split('\n')[0]).toBe('match');
    await rm(join(project, '.envvault.json'));
  });

  it('diagnoses the setup', async () => {
    const result = await ci(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      checks: { name: string; outcome: string }[];
    };
    expect(report.mode).toBe('machine');
    expect(report.checks.find((c) => c.name === 'Service credential')?.outcome).toBe('ok');
    expectClean(result);
  });

  it('fails with the auth exit code once the credential is revoked', async () => {
    await api.stepUp(w.owner);
    await api.ok(
      api.call(w.owner, 'post', `${base()}/${identityId}/credentials/${credentialId}/revoke`, {}),
      200,
    );
    const result = await ci(['run', '--env', 'development', '--', process.execPath, '-e', '0']);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('revoked');
    expectClean(result);
    const bad = await envvault(['auth', 'service'], {
      ENVVAULT_SERVICE_CREDENTIAL: 'not-a-credential',
    });
    expect(bad.code).toBe(3);
    expect(bad.stderr).not.toContain('not-a-credential');
  });
});
