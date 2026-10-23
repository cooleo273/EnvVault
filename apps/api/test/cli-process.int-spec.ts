import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { cliSessionListSchema } from '@envvault/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

/**
 * The built CLI (apps/cli/dist) as a separate process against the real API
 * on a loopback port. Synthetic values only; assertions check that no value
 * or token reaches the CLI's own output.
 */
const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const VALUE = 'synthetic-cli-process-value-91c4';
const DIGEST = createHash('sha256').update(VALUE).digest('hex');
const posixOnly = process.platform === 'win32' ? it.skip : it;

let h: Harness;
let api: ReturnType<typeof client>;
let apiUrl: string;
let home: string;
let project: string;
let dev: TestUser;
let devMembership: string;
let w: Awaited<ReturnType<ReturnType<typeof client>['world']>>;

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function start(args: string[], env: Record<string, string> = {}) {
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
  const result: Result = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => (result.stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (result.stderr += chunk.toString()));
  const done = new Promise<Result>((resolve) => {
    child.once('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      resolve(result);
    });
  });
  return { child, result, done };
}

function envvault(args: string[], env: Record<string, string> = {}) {
  return start(args, env).done;
}

async function until(check: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `envvault login --no-browser`, approved through the API as the web app would. */
async function login(user: TestUser) {
  const run = start(['login', '--no-browser']);
  await until(() => /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/.test(run.result.stderr));
  const userCode =
    /([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/.exec(run.result.stderr)?.[1] ?? '';
  await api.stepUp(user);
  await api.ok(api.call(user, 'post', '/cli/device/approve', { userCode }), 204);
  return run.done;
}

function expectClean(result: Result) {
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(VALUE);
  expect(output).not.toMatch(/evv_(at|rt)_/);
}

function json(result: Result): unknown {
  expect(result.stderr && result.code !== 0 ? result.stderr : '', 'stderr').toBe('');
  return JSON.parse(result.stdout);
}

const credentialsPath = () => join(home, 'config', 'credentials.json');

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error('Build the CLI first: pnpm --filter @envvault/cli build');
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  apiUrl = await h.listen();
  api = client(h);
  await truncateAllTables(h.db);
  home = await mkdtemp(join(tmpdir(), 'envvault-cli-home-'));
  project = await mkdtemp(join(tmpdir(), 'envvault-cli-project-'));
  await writeFile(
    join(project, 'check.mjs'),
    [
      "import { createHash } from 'node:crypto';",
      "const value = process.env.API_TOKEN ?? '';",
      "const digest = createHash('sha256').update(value).digest('hex');",
      "console.log(digest === process.argv[2] ? 'match' : 'mismatch');",
      "console.log(process.env.PRESET ?? 'unset');",
    ].join('\n'),
  );

  w = await api.world('cli-process');
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'PRESET', value: 'from-envvault' });
  dev = h.newUser('cli-process-dev');
  devMembership = await api.addToProject(w, dev, 'project-developer');
}, 120_000);

afterAll(async () => {
  await h.stop();
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('envvault as a process', () => {
  it('signs in through browser approval and keeps tokens out of the terminal', async () => {
    const result = await login(dev);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Signed in as ${dev.email}`);
    expectClean(result);
    if (process.platform !== 'win32')
      expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);

    const whoami = await envvault(['whoami', '--json']);
    expect(whoami.code).toBe(0);
    expect(JSON.parse(whoami.stdout)).toMatchObject({ email: dev.email });
    const status = await envvault(['auth', 'status']);
    expect(status.code).toBe(0);
    expectClean(status);
  });

  it('refreshes an expired access token and stores the rotated refresh token', async () => {
    const before = JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<
      string,
      { accessExpiresAt: string; refreshToken: string }
    >;
    const stored = before[apiUrl];
    if (!stored) throw new Error('no stored credential');
    stored.accessExpiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(credentialsPath(), JSON.stringify(before), { mode: 0o600 });
    const result = await envvault(['whoami']);
    expect(result.code).toBe(0);
    const after = JSON.parse(await readFile(credentialsPath(), 'utf8')) as typeof before;
    expect(after[apiUrl]?.refreshToken).not.toBe(stored.refreshToken);
  });

  it('links the directory with ids only and writes no .env file', async () => {
    const result = await envvault([
      'init',
      '--workspace',
      w.ws,
      '--project',
      'backend',
      '--env',
      'development',
    ]);
    expect(result.code).toBe(0);
    const config = JSON.parse(await readFile(join(project, '.envvault.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(config).sort()).toEqual([
      'apiUrl',
      'environmentId',
      'projectId',
      'version',
      'workspaceId',
    ]);
    expect(config).toMatchObject({ workspaceId: w.ws, projectId: w.project, environmentId: w.dev });
    expect(existsSync(join(project, '.env'))).toBe(false);
    expect(existsSync(join(project, '.env.local'))).toBe(false);

    const again = await envvault(['init']);
    expect(again.code).toBe(2);
    const envs = await envvault(['env', 'list', '--json']);
    expect((json(envs) as { name: string }[]).map((e) => e.name).sort()).toEqual([
      'Development',
      'Production',
    ]);
    const info = await envvault(['env', 'info', '--json']);
    expect(json(info)).toMatchObject({ name: 'Development', canRun: true });
  });

  it('injects values into the child only', async () => {
    const result = await envvault(['run', '--', process.execPath, 'check.mjs', DIGEST]);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')).toEqual(['match', 'from-envvault', '']);
    expect(result.stderr).toContain('Loaded 2 variables from Development');
    expectClean(result);
  });

  it('keeps variables already set with --no-override', async () => {
    const result = await envvault(
      ['run', '--no-override', '--', process.execPath, 'check.mjs', DIGEST],
      { PRESET: 'from-shell' },
    );
    expect(result.stdout.split('\n')).toEqual(['match', 'from-shell', '']);
  });

  it('forwards exit codes and reports missing commands', async () => {
    expect((await envvault(['run', '--', process.execPath, '-e', 'process.exit(7)'])).code).toBe(7);
    expect((await envvault(['run', '--', 'envvault-no-such-command'])).code).toBe(127);
  });

  posixOnly('forwards termination signals to the child', async () => {
    const handled = start([
      'run',
      '--',
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000);",
    ]);
    await until(() => handled.result.stdout.includes('ready'));
    handled.child.kill('SIGTERM');
    expect((await handled.done).code).toBe(0);

    const unhandled = start([
      'run',
      '--',
      process.execPath,
      '-e',
      "console.log('ready'); setInterval(() => {}, 1000);",
    ]);
    await until(() => unhandled.result.stdout.includes('ready'));
    unhandled.child.kill('SIGTERM');
    expect((await unhandled.done).code).toBe(143);
  });

  it('stops before running when required values are missing', async () => {
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'MUST_HAVE', isRequired: true });
    const blocked = await envvault(['run', '--', process.execPath, '-e', 'process.exit(0)']);
    expect(blocked.code).toBe(8);
    expect(blocked.stderr).toContain('MUST_HAVE');
    const allowed = await envvault([
      'run',
      '--allow-missing',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    expect(allowed.code).toBe(0);
  });

  it('refuses a protected environment without a direct grant', async () => {
    const result = await envvault([
      'run',
      '--env',
      'production',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    expect(result.code).toBe(5);
    expectClean(result);
  });

  it('writes a private .env file on pull only with export permission', async () => {
    await new Promise<void>((resolve, reject) => {
      spawn('git', ['init', '-q'], { cwd: project, stdio: 'ignore' }).once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('git init'));
      });
    });
    const denied = await envvault(['pull']);
    expect(denied.code).toBe(5);
    expect(denied.stderr).toContain('secret:export');
    expect(existsSync(join(project, '.env.local'))).toBe(false);

    await api.grant(w, w.dev, devMembership, 'environment-exporter');
    const result = await envvault(['pull']);
    expect(result.code, result.stderr).toBe(0);
    expectClean(result);
    const file = join(project, '.env.local');
    expect(await readFile(file, 'utf8')).toContain(`API_TOKEN=${VALUE}`);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toContain('/.env.local');

    expect((await envvault(['pull'])).code).toBe(2);
    expect((await envvault(['pull', '--force'])).code).toBe(0);
    await mkdir(join(project, 'public'), { recursive: true });
    expect((await envvault(['pull', '--output', 'public/.env'])).code).toBe(2);
    expect((await envvault(['pull', '--output', '../outside.env'])).code).toBe(2);
    expect(existsSync(join(project, 'public', '.env'))).toBe(false);
  });

  it('diagnoses the setup without printing values or tokens', async () => {
    const result = await envvault(['doctor', '--json']);
    const report = json({ ...result, code: 0 }) as {
      ok: boolean;
      checks: { name: string; outcome: string }[];
    };
    const outcome = (name: string) => report.checks.find((c) => c.name === name)?.outcome;
    expect(outcome('API')).toBe('ok');
    expect(outcome('Signed in')).toBe('ok');
    expect(outcome('Runtime access')).toBe('ok');
    expect(outcome('Required variables')).toBe('fail');
    expect(result.code).toBe(1);
    expectClean(result);
  });

  it('reports an unreachable API', async () => {
    const result = await envvault(['health'], { ENVVAULT_API_URL: 'http://127.0.0.1:9' });
    expect(result.code).toBe(7);
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('stops working once the session is revoked in the web app', async () => {
    const { items } = await api.ok(
      api.call(dev, 'get', '/cli/sessions'),
      200,
      cliSessionListSchema,
    );
    for (const session of items)
      await api.ok(api.call(dev, 'delete', `/cli/sessions/${session.id}`), 204);
    const result = await envvault(['run', '--', process.execPath, '-e', 'process.exit(0)']);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('envvault login');
  });

  it('ends the session on logout', async () => {
    expect((await login(dev)).code).toBe(0);
    const result = await envvault(['logout']);
    expect(result.code).toBe(0);
    expect(existsSync(credentialsPath())).toBe(false);
    const active = await h.db.cliSession.count({ where: { revokedAt: null } });
    expect(active).toBe(0);
    expect((await envvault(['whoami'])).code).toBe(4);
  });
});
