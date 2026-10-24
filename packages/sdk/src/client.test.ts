import { describe, expect, it, vi } from 'vitest';
import { createEnvVaultClient } from './client.js';
import {
  EnvVaultApiError,
  EnvVaultIncompatibleApiError,
  EnvVaultNetworkError,
  EnvVaultResponseValidationError,
} from './errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const healthBody = {
  status: 'ok',
  service: 'envvault-api',
  version: '0.0.0',
  uptimeSeconds: 3,
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('EnvVaultClient', () => {
  it('calls the versioned health endpoint and returns the parsed body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, healthBody));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000/ignored',
      fetch: fetchMock,
    });

    await expect(client.health()).resolves.toEqual(healthBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns readiness bodies for 503 responses', async () => {
    const body = {
      status: 'error',
      checks: { database: { status: 'down' } },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, body)),
    });
    await expect(client.readiness()).resolves.toEqual(body);
  });

  it('throws a typed error carrying the API error envelope', async () => {
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(429, {
          error: {
            statusCode: 429,
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many requests',
            requestId: 'req-12345678',
          },
        }),
      ),
    });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvVaultApiError);
    expect(error).toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      requestId: 'req-12345678',
    });
  });

  it('rejects responses that do not match the contract', async () => {
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { status: 'ok' })),
    });
    await expect(client.health()).rejects.toBeInstanceOf(EnvVaultResponseValidationError);
  });

  it('rejects non-http base URLs', () => {
    expect(() => createEnvVaultClient({ baseUrl: 'file:///etc/passwd' })).toThrow(/http or https/);
  });
});

describe('EnvVaultClient (authenticated)', () => {
  const me = {
    user: {
      id: '0199d6a2-7c4e-7a3b-9f10-1234567890ab',
      email: 'a@example.test',
      displayName: null,
      emailVerified: true,
      createdAt: '2026-10-19T10:00:00.000Z',
    },
    workspaces: [],
    activeWorkspaceId: null,
    pendingInvitationCount: 0,
  };

  it('sends the access token as a Bearer header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, me));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken: () => Promise.resolve('header.payload.signature'),
    });
    await expect(client.me()).resolves.toEqual(me);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ authorization: 'Bearer header.payload.signature' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/api/v1/users/me');
  });

  it('builds project and environment paths and query strings', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken: () => Promise.resolve('t'),
    });
    await client.setProjectFavorite('w', 'p', true);
    await client.setProjectFavorite('w', 'p', false);
    await client.reorderEnvironments('w', 'p', ['a', 'b']);
    await client.deleteEnvironment('w', 'p', 'e/1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method]);
    expect(calls).toEqual([
      ['http://localhost:4000/api/v1/workspaces/w/projects/p/favorite', 'PUT'],
      ['http://localhost:4000/api/v1/workspaces/w/projects/p/favorite', 'DELETE'],
      ['http://localhost:4000/api/v1/workspaces/w/projects/p/environments/order', 'PUT'],
      ['http://localhost:4000/api/v1/workspaces/w/projects/p/environments/e%2F1', 'DELETE'],
    ]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { items: [], page: 2, pageSize: 10, total: 0 }),
    );
    await client.listProjects('w', {
      q: 'pay ments',
      status: 'all',
      page: 2,
      pageSize: 10,
      sort: undefined,
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      'http://localhost:4000/api/v1/workspaces/w/projects?q=pay+ments&status=all&page=2&pageSize=10',
    );
  });

  it('builds workspace-scoped paths with encoded ids and the right verbs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken: () => Promise.resolve('t'),
    });
    await client.changeMemberRole('ws/1', 'm 1', 'viewer');
    await client.revokeInvitation('ws', 'inv');
    await client.declineInvitation({ token: 'abc' });
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body]);
    expect(calls).toEqual([
      [
        'http://localhost:4000/api/v1/workspaces/ws%2F1/members/m%201',
        'PATCH',
        '{"roleKey":"viewer"}',
      ],
      ['http://localhost:4000/api/v1/workspaces/ws/invitations/inv', 'DELETE', undefined],
      ['http://localhost:4000/api/v1/invitations/decline', 'POST', '{"token":"abc"}'],
    ]);
  });

  it('fails fast without contacting the API when no token is available', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken: () => Promise.resolve(null),
    });
    await expect(client.me()).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces API error codes such as STEP_UP_REQUIRED', async () => {
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      getAccessToken: () => Promise.resolve('t.t.t'),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(403, {
          error: { statusCode: 403, code: 'STEP_UP_REQUIRED', message: 'Confirm your password' },
        }),
      ),
    });
    await expect(client.deleteWorkspace('id')).rejects.toMatchObject({
      statusCode: 403,
      code: 'STEP_UP_REQUIRED',
    });
  });

  it('handles 204 responses', async () => {
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      getAccessToken: () => Promise.resolve('t.t.t'),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    });
    await expect(client.logout('all')).resolves.toBeUndefined();
  });
});

describe('retries and failures', () => {
  const token = () => Promise.resolve('t');

  it('retries reads after a network failure or a 503, never a plain mutation', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValue(jsonResponse(200, healthBody));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      retries: 2,
    });
    await expect(client.health()).resolves.toEqual(healthBody);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const post = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, {}));
    const writer = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: post,
      retries: 2,
      getAccessToken: token,
    });
    await expect(
      writer.runtimeConfiguration(
        '0190a000-0000-7000-8000-000000000001',
        '0190a000-0000-7000-8000-000000000002',
        '0190a000-0000-7000-8000-000000000003',
      ),
    ).rejects.toBeInstanceOf(EnvVaultApiError);
    expect(post).toHaveBeenCalledTimes(1);

    const keyed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const idempotent = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: keyed,
      retries: 1,
      getAccessToken: token,
    }).withIdempotencyKey('key-0123456789abcdef');
    await idempotent.endCliSession();
    expect(keyed).toHaveBeenCalledTimes(2);
  });

  it('reports unreachable and slow servers without their address', async () => {
    const down = createEnvVaultClient({
      baseUrl: 'http://10.0.0.1:4000',
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('connect ECONNREFUSED 10.0.0.1:4000')),
    });
    const error = await down.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvVaultNetworkError);
    expect((error as Error).message).not.toContain('10.0.0.1');
    const slow = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' })),
    });
    expect(((await slow.health().catch((e: unknown) => e)) as EnvVaultNetworkError).reason).toBe(
      'timeout',
    );
  });

  it('refuses an API that speaks another protocol version', async () => {
    const meta = (protocolVersion: number) =>
      createEnvVaultClient({
        baseUrl: 'http://localhost:4000',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(200, {
            service: 'envvault-api',
            version: '1.0.0',
            protocolVersion,
            features: [],
          }),
        ),
      });
    await expect(meta(1).checkCompatibility()).resolves.toMatchObject({ protocolVersion: 1 });
    await expect(meta(2).checkCompatibility()).rejects.toBeInstanceOf(EnvVaultIncompatibleApiError);
  });
});

describe('machine identities', () => {
  const credential = `evv_sk_${'A'.repeat(16)}_${'b'.repeat(43)}`;
  const accessToken = `evv_mt_${'c'.repeat(43)}`;
  const issued = {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: '2026-01-01T00:15:00.000Z',
    scopes: ['secret:runtime'],
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
      expiresAt: '2026-02-01T00:00:00.000Z',
    },
  };

  it('sends the service credential only to the token exchange, never through getAccessToken', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, issued));
    const getAccessToken = vi.fn(() => Promise.resolve('unused'));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken,
    });
    await expect(client.exchangeServiceCredential(credential)).resolves.toMatchObject({
      accessToken,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:4000/api/v1/machine/token');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${credential}`);
    expect(init?.body as string).not.toContain(credential);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('does not retry machine runtime loads or exchanges', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      retries: 3,
      getAccessToken: () => Promise.resolve(accessToken),
    });
    await expect(
      client.machineRuntime('0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c05'),
    ).rejects.toBeInstanceOf(EnvVaultNetworkError);
    await expect(client.exchangeServiceCredential(credential)).rejects.toBeInstanceOf(
      EnvVaultNetworkError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a response that does not look like a machine token', async () => {
    const client = createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(200, { ...issued, accessToken: 'not-a-token' })),
    });
    await expect(client.exchangeServiceCredential(credential)).rejects.toBeInstanceOf(
      EnvVaultResponseValidationError,
    );
  });
});
