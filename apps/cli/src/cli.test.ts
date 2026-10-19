import { EnvVaultApiError } from '@envvault/sdk';
import { describe, expect, it, vi } from 'vitest';
import { CLI_VERSION, DEFAULT_API_URL, run, type CliIo } from './cli.js';

const healthy = {
  status: 'ok' as const,
  service: 'envvault-api',
  version: '0.0.0',
  uptimeSeconds: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
};

function createIo(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    ...overrides,
  };
  return { io, out, err };
}

describe('envvault CLI', () => {
  it('prints the version', async () => {
    const { io, out } = createIo();
    await expect(run(['--version'], io)).resolves.toBe(0);
    expect(out.join('')).toBe(`${CLI_VERSION}\n`);
  });

  it('prints help when no command is given', async () => {
    const { io, out } = createIo();
    await expect(run([], io)).resolves.toBe(0);
    expect(out.join('')).toContain('Usage:');
  });

  it('fails on unknown commands and options', async () => {
    const { io, err } = createIo();
    await expect(run(['deploy'], io)).resolves.toBe(2);
    await expect(run(['--nope'], io)).resolves.toBe(2);
    expect(err.join('')).toContain('Unknown command: deploy');
  });

  it('checks API health using the default URL', async () => {
    const createClient = vi.fn(() => ({ health: () => Promise.resolve(healthy) }));
    const { io, out } = createIo({ createClient });

    await expect(run(['health'], io)).resolves.toBe(0);
    expect(createClient).toHaveBeenCalledWith(DEFAULT_API_URL);
    expect(out.join('')).toContain('API ok (envvault-api v0.0.0)');
  });

  it('prefers --api-url over ENVVAULT_API_URL and supports JSON output', async () => {
    const createClient = vi.fn(() => ({ health: () => Promise.resolve(healthy) }));
    const { io, out } = createIo({
      createClient,
      env: { ENVVAULT_API_URL: 'http://from-env:4000' },
    });

    await expect(run(['health', '--api-url', 'http://flag:4000', '--json'], io)).resolves.toBe(0);
    expect(createClient).toHaveBeenCalledWith('http://flag:4000');
    expect(JSON.parse(out.join(''))).toEqual(healthy);
  });

  it('reports API errors with a non-zero exit code', async () => {
    const createClient = () => ({
      health: () =>
        Promise.reject(
          new EnvVaultApiError(503, {
            statusCode: 503,
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service unavailable',
          }),
        ),
    });
    const { io, err } = createIo({ createClient });

    await expect(run(['health'], io)).resolves.toBe(1);
    expect(err.join('')).toContain('HTTP 503 SERVICE_UNAVAILABLE');
  });
});
