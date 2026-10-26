import { EnvVaultApiError } from '@envvault/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const api = vi.hoisted(() => ({
  createSecret: vi.fn(),
  updateSecret: vi.fn(),
  deleteSecret: vi.fn(),
  restoreSecret: vi.fn(),
  revealSecret: vi.fn(),
  stepUp: vi.fn(),
  exportSecrets: vi.fn(),
  importSecrets: vi.fn(),
  previewSecretImport: vi.fn(),
}));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('@/lib/api/server-api', async () => {
  const { EnvVaultApiError: ApiError } = await import('@envvault/sdk');
  return {
    withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
    withApiMutation: (call: (client: typeof api) => Promise<unknown>) => call(api),
    isApiError: (error: unknown, code?: string) =>
      error instanceof ApiError && (code === undefined || error.code === code),
  };
});

const actions = await import('./actions');

const W = '0199f000-0000-7000-8000-00000000000a';
const P = '0199f000-0000-7000-8000-00000000000b';
const E = '0199f000-0000-7000-8000-00000000000c';
const S = '0199f000-0000-7000-8000-00000000000d';
const SYNTHETIC = 'synthetic-web-value-31f0';

function apiError(statusCode: number, code: string, issues?: { path: string; message: string }[]) {
  return new EnvVaultApiError(statusCode, {
    statusCode,
    code,
    message: code,
    ...(issues ? { issues } : {}),
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  revalidatePath.mockReset();
});

describe('createSecretAction', () => {
  it('validates, creates and refreshes the environment page', async () => {
    api.createSecret.mockResolvedValue({ id: S, revision: 1 });
    const result = await actions.createSecretAction(W, P, E, {
      key: 'API_KEY',
      value: SYNTHETIC,
      tags: ['Billing'],
    });
    expect(result).toMatchObject({ ok: true, data: { id: S } });
    expect(api.createSecret).toHaveBeenCalledWith(
      W,
      P,
      E,
      expect.objectContaining({
        key: 'API_KEY',
        value: SYNTHETIC,
        type: 'SECRET',
        tags: ['billing'],
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/workspaces/${W}/projects/${P}/environments/${E}`);
  });

  it('rejects invalid input locally without echoing the value', async () => {
    const result = await actions.createSecretAction(W, P, E, {
      key: 'PORT',
      type: 'NUMBER',
      value: SYNTHETIC,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC);
    expect(api.createSecret).not.toHaveBeenCalled();
  });

  it('points duplicate names at the name field', async () => {
    api.createSecret.mockRejectedValue(apiError(409, 'SECRET_KEY_TAKEN'));
    const result = await actions.createSecretAction(W, P, E, { key: 'API_KEY', value: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'SECRET_KEY_TAKEN' });
    expect(result.ok ? undefined : result.fieldErrors?.key).toMatch(/already exists/);
  });

  it('sends the user to sign in when the session ended', async () => {
    api.createSecret.mockRejectedValue(apiError(401, 'TOKEN_EXPIRED'));
    await expect(actions.createSecretAction(W, P, E, { key: 'A', value: 'x' })).rejects.toThrow(
      RedirectSignal,
    );
  });
});

describe('updateSecretAction', () => {
  it('reports conflicts with their code so the dialog can offer a reload', async () => {
    api.updateSecret.mockRejectedValue(apiError(409, 'SECRET_CONFLICT'));
    const result = await actions.updateSecretAction(W, P, E, S, {
      expectedRevision: 3,
      value: SYNTHETIC,
    });
    expect(result).toMatchObject({ ok: false, code: 'SECRET_CONFLICT' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps API field issues onto fields', async () => {
    api.updateSecret.mockRejectedValue(
      apiError(400, 'BAD_REQUEST', [{ path: 'value', message: 'Enter valid JSON' }]),
    );
    const result = await actions.updateSecretAction(W, P, E, S, {
      expectedRevision: 1,
      description: 'x',
    });
    expect(result).toMatchObject({ ok: false, fieldErrors: { value: 'Enter valid JSON' } });
  });
});

describe('revealSecretAction', () => {
  it('relays the value without revalidating any cached page', async () => {
    api.revealSecret.mockResolvedValue({ id: S, key: 'K', type: 'SECRET', version: 2, value: '' });
    await expect(actions.revealSecretAction(W, P, E, S)).resolves.toEqual({
      ok: true,
      data: { value: '', version: 2, type: 'SECRET' },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('passes STEP_UP_REQUIRED through for protected environments', async () => {
    api.revealSecret.mockRejectedValue(apiError(403, 'STEP_UP_REQUIRED'));
    await expect(actions.revealSecretAction(W, P, E, S)).resolves.toMatchObject({
      ok: false,
      code: 'STEP_UP_REQUIRED',
    });
  });
});

describe('delete, restore and step up', () => {
  it('deletes with the expected revision and restores', async () => {
    api.deleteSecret.mockResolvedValue(undefined);
    api.restoreSecret.mockResolvedValue({ key: 'K' });
    await expect(actions.deleteSecretAction(W, P, E, S, 4)).resolves.toMatchObject({ ok: true });
    expect(api.deleteSecret).toHaveBeenCalledWith(W, P, E, S, 4);
    await expect(actions.restoreSecretAction(W, P, E, S)).resolves.toMatchObject({
      ok: true,
      message: 'K restored.',
    });
    expect(await actions.deleteSecretAction(W, P, E, S, 0)).toMatchObject({ ok: false });
  });

  it('reports a wrong password on the password field', async () => {
    api.stepUp.mockRejectedValue(apiError(401, 'STEP_UP_FAILED'));
    await expect(actions.confirmPasswordAction('wrong')).resolves.toMatchObject({
      ok: false,
      fieldErrors: { password: 'Incorrect password.' },
    });
  });
});

describe('import and export actions', () => {
  it('exports without revalidating any page', async () => {
    api.exportSecrets.mockResolvedValue({ filename: '.env.dev', content: SYNTHETIC });
    await expect(actions.exportAction(W, P, E, { format: 'json' })).resolves.toMatchObject({
      ok: true,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await actions.exportAction(W, P, E, { format: 'xml' })).toMatchObject({ ok: false });
  });

  it('imports and refreshes, and maps per key rejections onto fields', async () => {
    api.importSecrets.mockResolvedValue({ created: 1, updated: 0, secretIds: [S] });
    const input = { content: `A=${SYNTHETIC}`, items: [{ action: 'create', key: 'A' }] };
    await expect(actions.importAction(W, P, E, input)).resolves.toMatchObject({ ok: true });
    expect(revalidatePath).toHaveBeenCalled();
    api.importSecrets.mockRejectedValue(
      apiError(409, 'SECRET_IMPORT_REJECTED', [
        { path: 'A', message: 'A variable with this name exists now' },
      ]),
    );
    const rejected = await actions.importAction(W, P, E, input);
    expect(rejected).toMatchObject({
      ok: false,
      fieldErrors: { A: 'A variable with this name exists now' },
    });
    expect(JSON.stringify(rejected)).not.toContain(SYNTHETIC);
  });
});
