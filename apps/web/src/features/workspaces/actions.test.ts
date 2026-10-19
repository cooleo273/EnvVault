import { EnvVaultApiError } from '@envvault/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_FORM_STATE } from '@/lib/form-state';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const api = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  inviteMember: vi.fn(),
  stepUp: vi.fn(),
  deleteWorkspace: vi.fn(),
  transferOwnership: vi.fn(),
  changeMemberRole: vi.fn(),
  acceptInvitation: vi.fn(),
  lookupInvitation: vi.fn(),
  setActiveWorkspace: vi.fn(),
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

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function apiError(statusCode: number, code: string) {
  return new EnvVaultApiError(statusCode, { statusCode, code, message: 'server text' });
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RedirectSignal);
  return (error as RedirectSignal).url;
}

const WS = '0199f000-0000-7000-8000-00000000000a';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('createWorkspaceAction (form validation)', () => {
  it('validates name, slug and type before calling the API', async () => {
    const empty = await actions.createWorkspaceAction(INITIAL_FORM_STATE, form({ name: ' ' }));
    expect(empty.fieldErrors).toHaveProperty('name');
    const badSlug = await actions.createWorkspaceAction(
      INITIAL_FORM_STATE,
      form({ name: 'Acme', slug: 'Not A Slug' }),
    );
    expect(badSlug.fieldErrors).toHaveProperty('slug');
    const badType = await actions.createWorkspaceAction(
      INITIAL_FORM_STATE,
      form({ name: 'Acme', type: 'ORG' }),
    );
    expect(badType.fieldErrors).toHaveProperty('type');
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it('omits an empty slug so the server generates one, then opens the workspace', async () => {
    api.createWorkspace.mockResolvedValue({ id: WS });
    const url = await redirectOf(
      actions.createWorkspaceAction(
        INITIAL_FORM_STATE,
        form({ name: 'Acme', slug: '', type: 'TEAM' }),
      ),
    );
    expect(api.createWorkspace).toHaveBeenCalledWith({ name: 'Acme', type: 'TEAM' });
    expect(url).toBe(`/workspaces/${WS}?created=1`);
  });

  it('continues onboarding to the dashboard', async () => {
    api.createWorkspace.mockResolvedValue({ id: WS });
    expect(
      await redirectOf(
        actions.createWorkspaceAction(
          INITIAL_FORM_STATE,
          form({ name: 'Mine', next: 'dashboard' }),
        ),
      ),
    ).toBe('/dashboard?welcome=1');
  });

  it('maps a duplicate slug to a field error without echoing server text', async () => {
    api.createWorkspace.mockRejectedValue(apiError(409, 'SLUG_TAKEN'));
    const state = await actions.createWorkspaceAction(
      INITIAL_FORM_STATE,
      form({ name: 'Acme', slug: 'acme' }),
    );
    expect(state.fieldErrors).toEqual({ slug: 'That URL is already taken' });
    expect(state.message).not.toContain('server text');
  });

  it('sends users with an ended session to sign-in', async () => {
    api.createWorkspace.mockRejectedValue(apiError(401, 'TOKEN_EXPIRED'));
    expect(
      await redirectOf(actions.createWorkspaceAction(INITIAL_FORM_STATE, form({ name: 'Acme' }))),
    ).toBe('/login');
  });
});

describe('member and invitation actions', () => {
  it('rejects invalid invitation input and never invites owners', async () => {
    for (const values of [
      { email: 'not-an-email', roleKey: 'member' },
      { email: 'a@example.com', roleKey: 'owner' },
      { email: 'a@example.com', roleKey: 'superuser' },
    ]) {
      const state = await actions.inviteMemberAction(WS, INITIAL_FORM_STATE, form(values));
      expect(state.status).toBe('error');
    }
    expect(api.inviteMember).not.toHaveBeenCalled();
  });

  it('reports honestly when the invitation was not emailed', async () => {
    api.inviteMember.mockResolvedValue({
      invitation: { email: 'a@example.com' },
      delivery: { status: 'not_configured' },
      acceptUrl: 'http://localhost:3000/invite#token=x',
    });
    const state = await actions.inviteMemberAction(
      WS,
      INITIAL_FORM_STATE,
      form({ email: 'A@Example.com', roleKey: 'viewer' }),
    );
    expect(api.inviteMember).toHaveBeenCalledWith(WS, {
      email: 'a@example.com',
      roleKey: 'viewer',
    });
    expect(state.message).toContain('It was not emailed');
    expect(state.issued?.acceptUrl).toContain('#token=');
  });

  it('validates role keys before changing a role', async () => {
    const result = await actions.changeMemberRoleAction(WS, WS, 'root');
    expect(result.ok).toBe(false);
    expect(api.changeMemberRole).not.toHaveBeenCalled();
    api.changeMemberRole.mockRejectedValue(apiError(409, 'LAST_OWNER'));
    const last = await actions.changeMemberRoleAction(WS, WS, 'admin');
    expect(last.ok).toBe(false);
    expect(last.ok ? '' : last.message).toContain('at least one owner');
  });

  it('refuses malformed invitation references without calling the API', async () => {
    expect((await actions.acceptInvitationAction({ token: 'short' })).ok).toBe(false);
    expect((await actions.acceptInvitationAction({ id: 'not-a-uuid' })).ok).toBe(false);
    expect(await actions.lookupInvitationAction('../../etc')).toMatchObject({ status: 'error' });
    expect(api.acceptInvitation).not.toHaveBeenCalled();
    expect(api.lookupInvitation).not.toHaveBeenCalled();
  });

  it('asks anonymous visitors of an invitation link to sign in', async () => {
    api.lookupInvitation.mockRejectedValue(apiError(401, 'UNAUTHENTICATED'));
    expect(await actions.lookupInvitationAction('A'.repeat(43))).toEqual({ status: 'signed_out' });
  });
});

describe('sensitive actions', () => {
  it('requires the typed slug and a password before deleting', async () => {
    const mismatch = await actions.deleteWorkspaceAction(
      WS,
      'acme',
      INITIAL_FORM_STATE,
      form({ confirmation: 'acm', password: 'pw' }),
    );
    expect(mismatch.fieldErrors).toHaveProperty('confirmation');
    const noPassword = await actions.deleteWorkspaceAction(
      WS,
      'acme',
      INITIAL_FORM_STATE,
      form({ confirmation: 'acme', password: '' }),
    );
    expect(noPassword.fieldErrors).toHaveProperty('password');
    expect(api.stepUp).not.toHaveBeenCalled();
  });

  it('re-verifies the password before transferring ownership', async () => {
    api.stepUp.mockRejectedValue(apiError(403, 'STEP_UP_FAILED'));
    const state = await actions.transferOwnershipAction(
      WS,
      INITIAL_FORM_STATE,
      form({ membershipId: WS, password: 'wrong' }),
    );
    expect(state.fieldErrors).toEqual({ password: 'Incorrect password' });
    expect(api.transferOwnership).not.toHaveBeenCalled();

    const invalid = await actions.transferOwnershipAction(
      WS,
      INITIAL_FORM_STATE,
      form({ membershipId: 'x', password: 'pw' }),
    );
    expect(invalid.fieldErrors).toHaveProperty('membershipId');
  });

  it('only remembers workspaces by valid id', async () => {
    expect(await redirectOf(actions.selectWorkspaceAction('nope'))).toBe('/workspaces');
    expect(api.setActiveWorkspace).not.toHaveBeenCalled();
    api.setActiveWorkspace.mockRejectedValue(apiError(404, 'NOT_FOUND'));
    expect(await redirectOf(actions.selectWorkspaceAction(WS))).toBe('/workspaces');
  });
});
