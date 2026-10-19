import { describe, expect, it, vi } from 'vitest';
import { createEnvVaultClient } from './client.js';
import { EnvVaultApiError, EnvVaultResponseValidationError } from './errors.js';

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
