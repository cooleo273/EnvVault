import type * as sdk from '@envvault/sdk';
import { EnvVaultApiError } from '@envvault/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const keys: string[] = [];
const calls = vi.fn<() => Promise<string>>();

vi.mock('server-only', () => ({}));
vi.mock('@/server-env', () => ({
  serverEnv: () => ({ NEXT_PUBLIC_API_URL: 'http://localhost:4000', API_INTERNAL_URL: undefined }),
}));
vi.mock('@/lib/auth/server', () => ({
  getAuth: () => ({ token: () => Promise.resolve({ data: { token: 't' }, error: null }) }),
}));
vi.mock('@envvault/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof sdk>();
  const scoped = { createSecret: () => calls() };
  return {
    ...actual,
    createEnvVaultClient: () => ({
      withIdempotencyKey: (key: string) => {
        keys.push(key);
        return scoped;
      },
    }),
  };
});

const { withApiMutation } = await import('./server-api');

beforeEach(() => {
  keys.length = 0;
  calls.mockReset();
});

describe('withApiMutation', () => {
  it('retries a network failure once with the same idempotency key', async () => {
    calls.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce('done');
    await expect(
      withApiMutation((api) =>
        (api as unknown as { createSecret: () => Promise<string> }).createSecret(),
      ),
    ).resolves.toBe('done');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^web-[0-9a-f-]{36}$/);
  });

  it('does not retry a refusal from the API, and uses a new key per action', async () => {
    calls.mockRejectedValue(
      new EnvVaultApiError(403, { statusCode: 403, code: 'FORBIDDEN', message: 'no' }),
    );
    const run = () =>
      withApiMutation((api) =>
        (api as unknown as { createSecret: () => Promise<string> }).createSecret(),
      );
    await expect(run()).rejects.toBeInstanceOf(EnvVaultApiError);
    await expect(run()).rejects.toBeInstanceOf(EnvVaultApiError);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(new Set(keys).size).toBe(2);
  });
});
