import { describe, expect, it, vi } from 'vitest';
import { createEnvVaultClient } from './client.js';
import { EnvVaultApiError } from './errors.js';

const WS = '0190a000-0000-7000-8000-000000000001';
const PROJECT = '0190a000-0000-7000-8000-000000000002';
const ENV = '0190a000-0000-7000-8000-000000000003';
const SECRET = '0190a000-0000-7000-8000-000000000004';
const BASE = `http://localhost:4000/api/v1/workspaces/${WS}/projects/${PROJECT}/environments/${ENV}/secrets`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    fetchMock,
    api: createEnvVaultClient({
      baseUrl: 'http://localhost:4000',
      fetch: fetchMock,
      getAccessToken: () => Promise.resolve('token'),
    }),
  };
}

describe('secrets', () => {
  it('sends list filters as comma separated query parameters', async () => {
    const { api, fetchMock } = client(
      jsonResponse(200, {
        items: [],
        page: 1,
        pageSize: 50,
        total: 0,
        facets: { categories: [], tags: [] },
      }),
    );
    await api.listSecrets(WS, PROJECT, ENV, {
      q: 'db',
      type: ['SECRET', 'JSON'],
      category: ['Database', 'none'],
      sort: 'updated',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${BASE}?q=db&sort=updated&type=SECRET%2CJSON&category=Database%2Cnone`,
    );
  });

  it('reveals with POST and validates the response', async () => {
    const { api, fetchMock } = client(
      jsonResponse(200, { id: SECRET, key: 'K', type: 'SECRET', version: 2, value: '' }),
    );
    await expect(api.revealSecret(WS, PROJECT, ENV, SECRET)).resolves.toMatchObject({
      value: '',
      version: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/${SECRET}/reveal`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces conflicts as typed errors', async () => {
    const { api } = client(
      jsonResponse(409, {
        error: { statusCode: 409, code: 'SECRET_CONFLICT', message: 'Changed by someone else' },
      }),
    );
    const error = await api
      .updateSecret(WS, PROJECT, ENV, SECRET, { expectedRevision: 1, description: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvVaultApiError);
    expect((error as EnvVaultApiError).code).toBe('SECRET_CONFLICT');
  });

  it('passes the expected revision when deleting', async () => {
    const { api, fetchMock } = client(jsonResponse(204, undefined));
    await api.deleteSecret(WS, PROJECT, ENV, SECRET, 3);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/${SECRET}?expectedRevision=3`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
