import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvVaultClient } from './client.js';
import { EnvVaultAbortError, EnvVaultApiError } from './errors.js';
import { EnvVaultMachineClient } from './machine.js';
import { machineClientFromEnvironment } from './node.js';
import { collect, paginate, paginateBefore, paginateCursor } from './pagination.js';

const BASE = 'http://localhost:4000';
const CREDENTIAL = `evv_sk_${'A'.repeat(16)}_${'b'.repeat(43)}`;
const posixOnly = process.platform === 'win32' ? it.skip : it;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const health = {
  status: 'ok',
  service: 'envvault-api',
  version: '0.0.0',
  uptimeSeconds: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
};
const rateLimited = (seconds: string) =>
  json(
    429,
    { error: { statusCode: 429, code: 'TOO_MANY_REQUESTS', message: 'Slow down' } },
    { 'retry-after': seconds, 'x-request-id': 'req-429' },
  );

describe('cancellation', () => {
  it('stops a request when the caller aborts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const controller = new AbortController();
    const client = createEnvVaultClient({ baseUrl: BASE, fetch }).withSignal(controller.signal);
    const pending = client.health();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(EnvVaultAbortError);
  });

  it('does not send anything once aborted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createEnvVaultClient({ baseUrl: BASE, fetch, signal: controller.signal }).health(),
    ).rejects.toBeInstanceOf(EnvVaultAbortError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('rate limits', () => {
  it('reports Retry-After and the request id from headers', async () => {
    const client = createEnvVaultClient({
      baseUrl: BASE,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(rateLimited('7')),
    });
    const error = (await client.health().catch((e: unknown) => e)) as EnvVaultApiError;
    expect(error).toBeInstanceOf(EnvVaultApiError);
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.requestId).toBe('req-429');
  });

  it('waits and retries reads only when asked to', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rateLimited('0'))
      .mockResolvedValueOnce(json(200, health));
    const client = createEnvVaultClient({ baseUrl: BASE, fetch, rateLimitRetries: 1 });
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never repeats a write without an idempotency key, and never waits too long', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(rateLimited('0'));
    const client = createEnvVaultClient({
      baseUrl: BASE,
      fetch,
      rateLimitRetries: 3,
      getAccessToken: () => Promise.resolve('t'),
    });
    await expect(client.createWorkspace({ name: 'x' })).rejects.toBeInstanceOf(EnvVaultApiError);
    expect(fetch).toHaveBeenCalledTimes(1);

    const slow = vi.fn<typeof globalThis.fetch>().mockResolvedValue(rateLimited('120'));
    await expect(
      createEnvVaultClient({ baseUrl: BASE, fetch: slow, rateLimitRetries: 3 }).health(),
    ).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('pagination', () => {
  it('walks page numbers until the total is reached', async () => {
    const pages = vi.fn((page: number) =>
      Promise.resolve({
        items: page < 3 ? [page * 10, page * 10 + 1] : [30],
        page,
        pageSize: 2,
        total: 5,
      }),
    );
    expect(await collect(paginate(pages))).toEqual([10, 11, 20, 21, 30]);
    expect(pages).toHaveBeenCalledTimes(3);
  });

  it('follows cursors and before markers, and stops on limits', async () => {
    const cursor = (c: string | undefined) =>
      Promise.resolve(
        c === undefined ? { items: ['a'], nextCursor: 'next' } : { items: ['b'], nextCursor: null },
      );
    expect(await collect(paginateCursor(cursor))).toEqual(['a', 'b']);
    const before = (b: number | undefined) =>
      Promise.resolve(
        b === undefined ? { items: [3, 2], nextBefore: 2 } : { items: [1], nextBefore: null },
      );
    expect(await collect(paginateBefore(before))).toEqual([3, 2, 1]);
    const endless = () => Promise.resolve({ items: [1], nextCursor: 'again' });
    expect(await collect(paginateCursor(endless, { maxPages: 4 }))).toHaveLength(4);
    expect(await collect(paginateCursor(endless), 2)).toEqual([1, 1]);
  });
});

const token = (n: number, expiresInMs = 900_000) => ({
  accessToken: `evv_mt_${String(n).repeat(43).slice(0, 43)}`,
  tokenType: 'Bearer',
  expiresIn: Math.round(expiresInMs / 1000),
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  scopes: ['environment:read', 'secret:runtime'],
  environmentIds: [],
  identity: {
    id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c01',
    name: 'ci',
    workspaceId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c02',
    projectId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c03',
  },
  credential: {
    id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c04',
    name: 'ci',
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
});
const environment = {
  id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c05',
  name: 'Staging',
  slug: 'staging',
  kind: 'STAGING',
  isProtected: false,
  status: 'ACTIVE',
  permissions: ['environment:read', 'secret:runtime'],
};
const runtime = {
  environmentId: environment.id,
  values: [{ key: 'API_URL', value: 'synthetic', source: 'local' }],
  missingRequired: [],
  withheldInherited: 0,
  issuedAt: '2026-01-01T00:00:00.000Z',
};

/** A fake machine API: counts exchanges and can reject the first use of a token. */
function machineApi(options: { rejectFirstUse?: boolean; expiresInMs?: number } = {}) {
  let exchanges = 0;
  let rejected = !options.rejectFirstUse;
  const authorizations: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    authorizations.push(auth);
    if (url.endsWith('/machine/token')) {
      exchanges++;
      return Promise.resolve(json(200, token(exchanges, options.expiresInMs)));
    }
    if (!rejected) {
      rejected = true;
      return Promise.resolve(
        json(401, { error: { statusCode: 401, code: 'TOKEN_REVOKED', message: 'revoked' } }),
      );
    }
    if (url.endsWith('/machine/environments'))
      return Promise.resolve(json(200, { items: [environment] }));
    if (url.endsWith('/runtime')) return Promise.resolve(json(200, runtime));
    if (url.endsWith('/machine/token/revoke'))
      return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(
      json(404, { error: { statusCode: 404, code: 'NOT_FOUND', message: 'x' } }),
    );
  });
  return { fetch, authorizations, exchanges: () => exchanges };
}

describe('machine client', () => {
  it('exchanges once for concurrent calls and reuses the token', async () => {
    const api = machineApi();
    const client = new EnvVaultMachineClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: api.fetch,
    });
    await Promise.all([client.environments(), client.environments(), client.environments()]);
    await client.runtimeValues('staging');
    expect(api.exchanges()).toBe(1);
    // The credential is sent to the exchange only.
    expect(api.authorizations.filter((a) => a.includes('evv_sk_'))).toHaveLength(1);
  });

  it('renews a token that is about to expire', async () => {
    const api = machineApi({ expiresInMs: 30_000 });
    const client = new EnvVaultMachineClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: api.fetch,
    });
    await client.environments();
    await client.environments();
    expect(api.exchanges()).toBe(2);
  });

  it('exchanges again once when the server rejects the token', async () => {
    const api = machineApi({ rejectFirstUse: true });
    const client = new EnvVaultMachineClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: api.fetch,
    });
    await expect(client.runtimeValues('Staging')).resolves.toEqual({ API_URL: 'synthetic' });
    expect(api.exchanges()).toBe(2);
  });

  it('never exposes the credential or tokens when logged or serialized', async () => {
    const api = machineApi();
    const client = new EnvVaultMachineClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: api.fetch,
    });
    await client.environments();
    const shown = `${JSON.stringify(client)} ${inspect(client)} ${String(Object.keys(client))}`;
    expect(shown).not.toContain('evv_sk_');
    expect(shown).not.toContain('evv_mt_');
    await client.close();
    expect(api.fetch.mock.calls.at(-1)?.[0]).toBe(`${BASE}/api/v1/machine/token/revoke`);
  });

  it('refuses an unknown environment without calling runtime', async () => {
    const api = machineApi();
    const client = new EnvVaultMachineClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: api.fetch,
    });
    await expect(client.runtime('production')).rejects.toMatchObject({ statusCode: 404 });
    expect(api.fetch.mock.calls.some(([url]) => (url as string).endsWith('/runtime'))).toBe(false);
  });
});

describe('machine client from the environment', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'envvault-sdk-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires an API address and a credential, without echoing bad values', () => {
    expect(() => machineClientFromEnvironment({})).toThrow(/ENVVAULT_API_URL/);
    expect(() => machineClientFromEnvironment({ ENVVAULT_API_URL: BASE })).toThrow(
      /ENVVAULT_SERVICE_CREDENTIAL/,
    );
    const error = (() => {
      try {
        machineClientFromEnvironment({
          ENVVAULT_API_URL: BASE,
          ENVVAULT_SERVICE_CREDENTIAL: 'ghp_synthetic',
        });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).not.toContain('ghp_synthetic');
  });

  posixOnly('reads a credential file only its owner can read', async () => {
    const path = join(dir, 'credential');
    await writeFile(path, CREDENTIAL, { mode: 0o644 });
    await chmod(path, 0o644);
    const api = machineApi();
    const client = machineClientFromEnvironment(
      { ENVVAULT_API_URL: BASE, ENVVAULT_SERVICE_CREDENTIAL_FILE: path },
      { fetch: api.fetch },
    );
    await expect(client.environments()).rejects.toThrow(/other users/);
    await chmod(path, 0o600);
    await expect(client.environments()).resolves.toHaveLength(1);
  });
});
