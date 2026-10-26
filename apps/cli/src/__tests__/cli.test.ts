import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_VERSION, DEFAULT_API_URL, main, type CliIo } from '../cli.js';
import { EXIT } from '../errors.js';

const healthy = {
  status: 'ok',
  service: 'envvault-api',
  version: '0.0.0',
  uptimeSeconds: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envvault-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createIo(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { ENVVAULT_CONFIG_DIR: dir, ENVVAULT_CREDENTIAL_STORE: 'file' },
    cwd: dir,
    interactive: false,
    ...overrides,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn((_url: string | URL | Request) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('envvault CLI', () => {
  it('prints the version', async () => {
    const { io, out } = createIo();
    await expect(main(['--version'], io)).resolves.toBe(EXIT.ok);
    expect(out()).toBe(`${CLI_VERSION}\n`);
  });

  it('prints help when no command is given', async () => {
    const { io, out } = createIo();
    await expect(main([], io)).resolves.toBe(EXIT.ok);
    expect(out()).toContain('Usage: envvault');
    for (const command of ['login', 'logout', 'whoami', 'init', 'run', 'pull', 'doctor'])
      expect(out()).toContain(command);
  });

  it('exits with the usage code on unknown commands and options', async () => {
    const { io, err } = createIo();
    await expect(main(['deploy'], io)).resolves.toBe(EXIT.usage);
    await expect(main(['--nope'], io)).resolves.toBe(EXIT.usage);
    expect(err()).toContain("unknown command 'deploy'");
  });

  it('checks API health using the default URL', async () => {
    const fetch = fakeFetch(healthy);
    const { io, out } = createIo({ fetch });
    await expect(main(['health'], io)).resolves.toBe(EXIT.ok);
    expect(fetch.mock.calls[0]?.[0] as string).toBe(`${DEFAULT_API_URL}/api/v1/health`);
    expect(out()).toContain('API ok (envvault-api v0.0.0)');
  });

  it('prefers --api-url over ENVVAULT_API_URL and prints JSON', async () => {
    const fetch = fakeFetch(healthy);
    const { io, out } = createIo({ fetch });
    io.env.ENVVAULT_API_URL = 'http://127.0.0.1:4999';
    await expect(
      main(['--api-url', 'http://localhost:4100', '--json', 'health'], io),
    ).resolves.toBe(EXIT.ok);
    expect(fetch.mock.calls[0]?.[0] as string).toBe('http://localhost:4100/api/v1/health');
    expect(JSON.parse(out())).toMatchObject({ status: 'ok' });
  });

  it('accepts global flags after the subcommand', async () => {
    const fetch = fakeFetch(healthy);
    const { io, out } = createIo({ fetch });
    await expect(
      main(['health', '--json', '--api-url', 'http://localhost:4100'], io),
    ).resolves.toBe(EXIT.ok);
    expect(fetch.mock.calls[0]?.[0] as string).toBe('http://localhost:4100/api/v1/health');
    expect(JSON.parse(out())).toMatchObject({ status: 'ok' });
  });

  it('refuses plain http to another host', async () => {
    const { io, err } = createIo({ fetch: fakeFetch(healthy) });
    await expect(main(['--api-url', 'http://api.example.com', 'health'], io)).resolves.toBe(
      EXIT.usage,
    );
    expect(err()).toContain('https');
  });

  it('reports an unreachable API without internals', async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:4000')),
    );
    const { io, err } = createIo({ fetch });
    await expect(main(['health'], io)).resolves.toBe(EXIT.unavailable);
    expect(err()).not.toContain('ECONNREFUSED');
    expect(err()).toContain('Check the API address');
  });

  it('asks to sign in when no credentials are stored', async () => {
    const { io, err } = createIo({ fetch: fakeFetch(healthy) });
    await expect(main(['whoami'], io)).resolves.toBe(EXIT.auth);
    expect(err()).toContain('envvault login');
  });

  it('requires a command after run', async () => {
    const { io } = createIo();
    await expect(main(['run'], io)).resolves.toBe(EXIT.usage);
  });

  it('rejects an unknown credential store', async () => {
    const { io, err } = createIo();
    io.env.ENVVAULT_CREDENTIAL_STORE = 'plaintext';
    await expect(main(['whoami'], io)).resolves.toBe(EXIT.usage);
    expect(err()).toContain('keychain or file');
  });
});
