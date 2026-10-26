import { EnvVaultApiError } from '@envvault/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createMachineIdentity: vi.fn(),
  issueServiceCredential: vi.fn(),
  grantMachineAccess: vi.fn(),
  revokeServiceCredential: vi.fn(),
}));
const mutation = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/api/server-api', async () => {
  const { EnvVaultApiError: ApiError } = await import('@envvault/sdk');
  return {
    withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
    withApiMutation: mutation,
    isApiError: (error: unknown, code?: string) =>
      error instanceof ApiError && (code === undefined || error.code === code),
  };
});

const actions = await import('./actions');

const W = '0199f000-0000-7000-8000-00000000000a';
const P = '0199f000-0000-7000-8000-00000000000b';
const I = '0199f000-0000-7000-8000-00000000000c';
const E = '0199f000-0000-7000-8000-00000000000d';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('machine identity actions', () => {
  it('validates input before calling the API', async () => {
    const result = await actions.createMachineIdentityAction(W, P, { name: '' });
    expect(result.ok).toBe(false);
    expect(api.createMachineIdentity).not.toHaveBeenCalled();
    const scopes = await actions.issueServiceCredentialAction(W, P, I, {
      name: 'ci',
      scopes: ['secret:read'],
    });
    expect(scopes.ok).toBe(false);
    expect(api.issueServiceCredential).not.toHaveBeenCalled();
  });

  it('refuses ids that are not UUIDs', async () => {
    const result = await actions.grantMachineAccessAction(W, '../other', I, {
      environmentId: E,
      roleKey: 'environment-runtime',
    });
    expect(result).toEqual({ ok: false, message: 'Not found.' });
    expect(api.grantMachineAccess).not.toHaveBeenCalled();
  });

  it('issues once, without the retrying mutation wrapper', async () => {
    api.issueServiceCredential.mockRejectedValue(new TypeError('fetch failed'));
    const result = await actions.issueServiceCredentialAction(W, P, I, {
      name: 'ci',
      scopes: ['secret:runtime'],
    });
    expect(result.ok).toBe(false);
    expect(api.issueServiceCredential).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('passes STEP_UP_REQUIRED through so the page can ask for the password', async () => {
    api.grantMachineAccess.mockRejectedValue(
      new EnvVaultApiError(403, {
        statusCode: 403,
        code: 'STEP_UP_REQUIRED',
        message: 'Confirm your password to continue',
      }),
    );
    const result = await actions.grantMachineAccessAction(W, P, I, {
      environmentId: E,
      roleKey: 'environment-runtime',
    });
    expect(result).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
  });

  it('reports a grant beyond the caller authority with the API message', async () => {
    api.grantMachineAccess.mockRejectedValue(
      new EnvVaultApiError(403, {
        statusCode: 403,
        code: 'GRANT_EXCEEDS_AUTHORITY',
        message: 'You can only grant what you hold here yourself (missing secret:runtime)',
      }),
    );
    const result = await actions.grantMachineAccessAction(W, P, I, {
      environmentId: E,
      roleKey: 'environment-runtime',
    });
    expect(result).toMatchObject({ ok: false, code: 'GRANT_EXCEEDS_AUTHORITY' });
    if (!result.ok) expect(result.message).toContain('secret:runtime');
  });

  it('sends a default reason when none is given on revoke', async () => {
    api.revokeServiceCredential.mockResolvedValue({ id: E });
    await actions.revokeServiceCredentialAction(W, P, I, E, '  ');
    expect(api.revokeServiceCredential).toHaveBeenCalledWith(W, P, I, E, {});
  });
});
