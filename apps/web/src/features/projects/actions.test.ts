import { EnvVaultApiError } from '@envvault/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_FORM_STATE } from '@/lib/form-state';
import { formatExpectedKeys, parseExpectedKeys } from './expected-keys';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  createEnvironment: vi.fn(),
  setEnvironmentProtection: vi.fn(),
  stepUp: vi.fn(),
  deleteEnvironment: vi.fn(),
  reorderEnvironments: vi.fn(),
  grantEnvironmentAccess: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('@/lib/api/server-api', async () => {
  const { EnvVaultApiError: ApiError } = await import('@envvault/sdk');
  return {
    withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
    isApiError: (error: unknown, code?: string) =>
      error instanceof ApiError && (code === undefined || error.code === code),
  };
});

const actions = await import('./actions');

const W = '0199f000-0000-7000-8000-00000000000a';
const P = '0199f000-0000-7000-8000-00000000000b';
const E = '0199f000-0000-7000-8000-00000000000c';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RedirectSignal);
  return (error as RedirectSignal).url;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('expected keys (names only)', () => {
  it('parses one key per line with optional descriptions and round-trips', () => {
    const keys = parseExpectedKeys('DATABASE_URL\n\n  API_KEY - Payment provider key  \n');
    expect(keys).toEqual([
      { key: 'DATABASE_URL' },
      { key: 'API_KEY', description: 'Payment provider key' },
    ]);
    expect(formatExpectedKeys(keys)).toBe('DATABASE_URL\nAPI_KEY - Payment provider key');
  });
});

describe('createProjectAction', () => {
  it('validates fields and environment definitions before calling the API', async () => {
    const noName = await actions.createProjectAction(W, INITIAL_FORM_STATE, form({ name: '' }));
    expect(noName.fieldErrors).toHaveProperty('name');
    const badSlug = await actions.createProjectAction(
      W,
      INITIAL_FORM_STATE,
      form({ name: 'A', slug: 'Bad Slug' }),
    );
    expect(badSlug.fieldErrors).toHaveProperty('slug');
    const badEnvs = await actions.createProjectAction(
      W,
      INITIAL_FORM_STATE,
      form({ name: 'A', environments: JSON.stringify([{ name: 'X', kind: 'NOPE' }]) }),
    );
    expect(badEnvs.status).toBe('error');
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('creates the project with the chosen environments and opens it', async () => {
    api.createProject.mockResolvedValue({ id: P, slug: 'backend' });
    const url = await redirectOf(
      actions.createProjectAction(
        W,
        INITIAL_FORM_STATE,
        form({
          name: 'Backend',
          icon: 'server',
          color: 'blue',
          environments: JSON.stringify([
            { name: 'Production', kind: 'PRODUCTION', isProtected: true },
          ]),
        }),
      ),
    );
    expect(url).toBe(`/workspaces/${W}/projects/${P}?created=1`);
    expect(api.createProject).toHaveBeenCalledWith(
      W,
      expect.objectContaining({ name: 'Backend', icon: 'server' }),
    );
  });

  it('maps a taken slug to a field error', async () => {
    api.createProject.mockRejectedValue(
      new EnvVaultApiError(409, { statusCode: 409, code: 'PROJECT_SLUG_TAKEN', message: 'x' }),
    );
    const state = await actions.createProjectAction(
      W,
      INITIAL_FORM_STATE,
      form({ name: 'A', slug: 'a' }),
    );
    expect(state.fieldErrors).toEqual({ slug: 'That URL is already taken' });
  });
});

describe('environment actions', () => {
  it('validates environment names, kinds and key names', async () => {
    const invalidKey = await actions.createEnvironmentAction(
      W,
      P,
      INITIAL_FORM_STATE,
      form({ name: 'QA', kind: 'TESTING', expectedKeys: 'HAS SPACE' }),
    );
    expect(invalidKey.status).toBe('error');
    const badKind = await actions.createEnvironmentAction(
      W,
      P,
      INITIAL_FORM_STATE,
      form({ name: 'QA', kind: 'LIVE' }),
    );
    expect(badKind.fieldErrors).toHaveProperty('kind');
    expect(api.createEnvironment).not.toHaveBeenCalled();
  });

  it('maps duplicate environment names to the name field', async () => {
    api.createEnvironment.mockRejectedValue(
      new EnvVaultApiError(409, { statusCode: 409, code: 'ENVIRONMENT_NAME_TAKEN', message: 'x' }),
    );
    const state = await actions.createEnvironmentAction(
      W,
      P,
      INITIAL_FORM_STATE,
      form({ name: 'QA' }),
    );
    expect(state.fieldErrors).toEqual({ name: 'Name already used' });
  });

  it('requires the password before removing protection, and re-verifies it', async () => {
    const missing = await actions.setEnvironmentProtectionAction(
      W,
      P,
      E,
      true,
      INITIAL_FORM_STATE,
      form({}),
    );
    expect(missing.fieldErrors).toHaveProperty('password');
    expect(api.setEnvironmentProtection).not.toHaveBeenCalled();

    const ok = await actions.setEnvironmentProtectionAction(
      W,
      P,
      E,
      true,
      INITIAL_FORM_STATE,
      form({ password: 'pw' }),
    );
    expect(ok.status).toBe('success');
    expect(api.stepUp).toHaveBeenCalledWith('pw');
    expect(api.setEnvironmentProtection).toHaveBeenCalledWith(W, P, E, {
      isProtected: false,
      requiredApprovals: 0,
    });

    // Turning protection on needs no password.
    api.stepUp.mockClear();
    await actions.setEnvironmentProtectionAction(
      W,
      P,
      E,
      false,
      INITIAL_FORM_STATE,
      form({ isProtected: 'on', requiredApprovals: '2' }),
    );
    expect(api.stepUp).not.toHaveBeenCalled();
    expect(api.setEnvironmentProtection).toHaveBeenLastCalledWith(W, P, E, {
      isProtected: true,
      requiredApprovals: 2,
    });
  });

  it('requires typed confirmation (and a password when protected) to delete', async () => {
    const mismatch = await actions.deleteEnvironmentAction(
      W,
      P,
      E,
      'production',
      true,
      INITIAL_FORM_STATE,
      form({ confirmation: 'prod', password: 'pw' }),
    );
    expect(mismatch.fieldErrors).toHaveProperty('confirmation');
    const noPassword = await actions.deleteEnvironmentAction(
      W,
      P,
      E,
      'production',
      true,
      INITIAL_FORM_STATE,
      form({ confirmation: 'production' }),
    );
    expect(noPassword.fieldErrors).toHaveProperty('password');
    expect(api.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('rejects malformed reorder input and grant dates', async () => {
    expect((await actions.reorderEnvironmentsAction(W, P, ['not-a-uuid'])).ok).toBe(false);
    const badGrant = await actions.grantEnvironmentAccessAction(
      W,
      P,
      E,
      INITIAL_FORM_STATE,
      form({ workspaceMembershipId: 'x', roleKey: 'environment-viewer' }),
    );
    expect(badGrant.status).toBe('error');
    expect(api.reorderEnvironments).not.toHaveBeenCalled();
    expect(api.grantEnvironmentAccess).not.toHaveBeenCalled();
  });
});
