import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_FORM_STATE } from '@/lib/form-state';
import { describeUserAgent } from './sessions-list';

class RedirectSignal extends Error {}

const auth = vi.hoisted(() => ({
  updateUser: vi.fn(),
  changePassword: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));
const api = vi.hoisted(() => ({ revokeTokens: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new RedirectSignal();
  },
}));
vi.mock('@/lib/auth/server', () => ({ getAuth: () => auth }));
vi.mock('@/lib/api/server-api', () => ({
  withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
  clientWithCurrentToken: () => Promise.resolve(api),
}));

const actions = await import('./actions');

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const fn of [...Object.values(auth), ...Object.values(api)]) fn.mockReset();
});

describe('updateProfileAction', () => {
  it('validates the name and updates it through Neon Auth', async () => {
    const empty = await actions.updateProfileAction(INITIAL_FORM_STATE, form({ name: '  ' }));
    expect(empty.fieldErrors).toHaveProperty('name');
    expect(auth.updateUser).not.toHaveBeenCalled();

    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    const saved = await actions.updateProfileAction(INITIAL_FORM_STATE, form({ name: ' Ada ' }));
    expect(auth.updateUser).toHaveBeenCalledWith({ name: 'Ada' });
    expect(saved.status).toBe('success');
  });
});

describe('changePasswordAction', () => {
  const valid = {
    currentPassword: 'old-password',
    newPassword: 'new-password-1',
    confirmPassword: 'new-password-1',
  };

  it('validates length, confirmation and reuse before contacting Neon Auth', async () => {
    for (const values of [
      { ...valid, newPassword: 'short', confirmPassword: 'short' },
      { ...valid, confirmPassword: 'different-1' },
      { ...valid, newPassword: 'old-password', confirmPassword: 'old-password' },
      { ...valid, currentPassword: '' },
    ]) {
      const state = await actions.changePasswordAction(INITIAL_FORM_STATE, form(values));
      expect(state.status).toBe('error');
    }
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it('changes the password, ends other sessions and revokes issued API tokens', async () => {
    auth.changePassword.mockResolvedValue({ data: {}, error: null });
    const state = await actions.changePasswordAction(INITIAL_FORM_STATE, form(valid));
    expect(auth.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-password',
      newPassword: 'new-password-1',
      revokeOtherSessions: true,
    });
    expect(api.revokeTokens).toHaveBeenCalledWith('password_changed');
    expect(state.status).toBe('success');
  });

  it('reports a wrong current password without revoking anything', async () => {
    auth.changePassword.mockResolvedValue({
      data: null,
      error: { status: 400, code: 'invalid_credentials' },
    });
    const state = await actions.changePasswordAction(INITIAL_FORM_STATE, form(valid));
    expect(state.fieldErrors).toEqual({ currentPassword: 'Incorrect password' });
    expect(api.revokeTokens).not.toHaveBeenCalled();
  });
});

describe('session revocation', () => {
  it('looks up the session token server-side and never ends the current session', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { id: 's-current' } } });
    auth.listSessions.mockResolvedValue({
      data: [
        { id: 's-current', token: 'tok-current' },
        { id: 's-other', token: 'tok-other' },
      ],
      error: null,
    });
    auth.revokeSession.mockResolvedValue({ data: {}, error: null });

    expect((await actions.revokeSessionAction('s-current')).ok).toBe(false);
    expect((await actions.revokeSessionAction('s-unknown')).ok).toBe(false);
    expect(auth.revokeSession).not.toHaveBeenCalled();

    expect((await actions.revokeSessionAction('s-other')).ok).toBe(true);
    expect(auth.revokeSession).toHaveBeenCalledWith({ token: 'tok-other' });
    expect(api.revokeTokens).toHaveBeenCalledWith('sessions_revoked');
  });
});

describe('describeUserAgent', () => {
  it('summarises common browsers without parsing libraries', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      ),
    ).toBe('Chrome on Windows');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });
});
