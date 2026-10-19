import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_FORM_STATE } from '@/lib/form-state';

/* ------------------------------------------------------------------ mocks */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const auth = vi.hoisted(() => ({
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  signOut: vi.fn(),
  revokeSessions: vi.fn(),
  getSession: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  emailOtp: { verifyEmail: vi.fn(), sendVerificationOtp: vi.fn() },
}));
const cookieJar = vi.hoisted(() => new Map<string, string>());
const api = vi.hoisted(() => ({ logout: vi.fn() }));
const calls = vi.hoisted(() => [] as string[]);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/server', () => ({ getAuth: () => auth }));
vi.mock('@/server-env', () => ({
  serverEnv: () => ({ NODE_ENV: 'test', APP_BASE_URL: 'https://app.example.com' }),
}));
vi.mock('@/lib/api/server-api', () => ({
  withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined),
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: ({ name }: { name: string }) => cookieJar.delete(name),
    }),
}));

const actions = await import('./actions');

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

const ok = <T>(data: T) => ({ data, error: null });
const fail = (code: string, status = 401) => ({
  data: null,
  error: { code, status, message: code },
});

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
  calls.length = 0;
  auth.getSession.mockResolvedValue(ok(null));
});

/* ------------------------------------------------------------------ tests */

describe('signInAction (login)', () => {
  it('signs in through Neon Auth and redirects to a safe destination', async () => {
    auth.signIn.email.mockResolvedValue(ok({ user: { id: 'u1' } }));
    const url = await redirectOf(
      actions.signInAction(
        INITIAL_FORM_STATE,
        form({ email: 'Dev@Example.test', password: 'secret-pass', redirectTo: '/workspaces' }),
      ),
    );
    expect(auth.signIn.email).toHaveBeenCalledWith({
      email: 'dev@example.test',
      password: 'secret-pass',
    });
    expect(url).toBe('/workspaces');
  });

  it('ignores open-redirect attempts after login', async () => {
    auth.signIn.email.mockResolvedValue(ok({ user: { id: 'u1' } }));
    const url = await redirectOf(
      actions.signInAction(
        INITIAL_FORM_STATE,
        form({ email: 'dev@example.test', password: 'x', redirectTo: 'https://evil.example' }),
      ),
    );
    expect(url).toBe('/dashboard');
  });

  it('returns a generic error for invalid credentials (no enumeration, no echo)', async () => {
    // Codes as normalized by the Neon SDK (Better Auth INVALID_EMAIL_OR_PASSWORD).
    auth.signIn.email.mockResolvedValue(fail('invalid_credentials'));
    const state = await actions.signInAction(
      INITIAL_FORM_STATE,
      form({ email: 'dev@example.test', password: 'wrong-password' }),
    );
    expect(state).toEqual({ status: 'error', message: 'Incorrect email or password.' });
    expect(JSON.stringify(state)).not.toContain('wrong-password');
  });

  it('validates input before contacting Neon Auth', async () => {
    const state = await actions.signInAction(
      INITIAL_FORM_STATE,
      form({ email: 'nope', password: '' }),
    );
    expect(state.status).toBe('error');
    expect(state.fieldErrors).toMatchObject({
      email: expect.any(String) as string,
      password: expect.any(String) as string,
    });
    expect(auth.signIn.email).not.toHaveBeenCalled();
  });

  it('routes unverified accounts to email verification', async () => {
    // The SDK maps Better Auth's EMAIL_NOT_VERIFIED to email_not_confirmed.
    auth.signIn.email.mockResolvedValue(fail('email_not_confirmed', 403));
    const url = await redirectOf(
      actions.signInAction(INITIAL_FORM_STATE, form({ email: 'dev@example.test', password: 'x' })),
    );
    expect(url).toBe('/verify-email');
    expect(cookieJar.get('envvault.pending-verification')).toBe('dev@example.test');
  });

  it('tells users to slow down when Neon Auth rate limits them', async () => {
    auth.signIn.email.mockResolvedValue(fail('over_request_rate_limit', 429));
    const state = await actions.signInAction(
      INITIAL_FORM_STATE,
      form({ email: 'dev@example.test', password: 'x' }),
    );
    expect(state.message).toMatch(/Too many attempts/);
  });

  it('reports an unavailable identity provider distinctly', async () => {
    auth.signIn.email.mockResolvedValue(fail('NETWORK_TIMEOUT', 502));
    const state = await actions.signInAction(
      INITIAL_FORM_STATE,
      form({ email: 'dev@example.test', password: 'x' }),
    );
    expect(state.message).toMatch(/unavailable/);
  });
});

describe('signUpAction (registration)', () => {
  it('creates the account with Neon Auth and continues to email verification', async () => {
    auth.signUp.email.mockResolvedValue(ok({ user: { id: 'u1', emailVerified: false } }));
    const url = await redirectOf(
      actions.signUpAction(
        INITIAL_FORM_STATE,
        form({ name: 'Dev', email: 'dev@example.test', password: 'long-enough-password' }),
      ),
    );
    expect(auth.signUp.email).toHaveBeenCalledWith({
      name: 'Dev',
      email: 'dev@example.test',
      password: 'long-enough-password',
    });
    expect(url).toBe('/verify-email');
  });

  it('enforces the minimum password length locally', async () => {
    const state = await actions.signUpAction(
      INITIAL_FORM_STATE,
      form({ name: 'Dev', email: 'dev@example.test', password: 'short' }),
    );
    expect(state.fieldErrors?.password).toMatch(/at least 8/);
    expect(auth.signUp.email).not.toHaveBeenCalled();
  });

  it('does not reveal whether an account already exists', async () => {
    auth.signUp.email.mockResolvedValue(fail('user_already_exists', 422));
    const state = await actions.signUpAction(
      INITIAL_FORM_STATE,
      form({ name: 'Dev', email: 'dev@example.test', password: 'long-enough-password' }),
    );
    expect(state.message).not.toMatch(/already exists/i);
  });
});

describe('email verification', () => {
  it('verifies the pending address with the emailed code', async () => {
    cookieJar.set('envvault.pending-verification', 'dev@example.test');
    auth.emailOtp.verifyEmail.mockResolvedValue(ok({ status: true, token: 'session', user: {} }));
    const url = await redirectOf(
      actions.verifyEmailAction(INITIAL_FORM_STATE, form({ otp: '123456' })),
    );
    expect(auth.emailOtp.verifyEmail).toHaveBeenCalledWith({
      email: 'dev@example.test',
      otp: '123456',
    });
    expect(url).toBe('/dashboard');
    expect(cookieJar.has('envvault.pending-verification')).toBe(false);
  });

  it('rejects wrong or expired codes', async () => {
    cookieJar.set('envvault.pending-verification', 'dev@example.test');
    auth.emailOtp.verifyEmail.mockResolvedValue(fail('INVALID_OTP', 400));
    const state = await actions.verifyEmailAction(INITIAL_FORM_STATE, form({ otp: '000000' }));
    expect(state.message).toMatch(/invalid or has expired/);
  });

  it('resends a verification code using the same Neon endpoint as the official UI', async () => {
    cookieJar.set('envvault.pending-verification', 'dev@example.test');
    auth.emailOtp.sendVerificationOtp.mockResolvedValue(ok({ success: true }));
    const state = await actions.resendVerificationAction(INITIAL_FORM_STATE);
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: 'dev@example.test',
      type: 'email-verification',
    });
    expect(state.status).toBe('success');
  });
});

describe('password recovery', () => {
  it('requests a reset link that returns to this app, without revealing account existence', async () => {
    auth.requestPasswordReset.mockResolvedValue(fail('USER_NOT_FOUND', 400));
    const state = await actions.requestPasswordResetAction(
      INITIAL_FORM_STATE,
      form({ email: 'ghost@example.test' }),
    );
    expect(auth.requestPasswordReset).toHaveBeenCalledWith({
      email: 'ghost@example.test',
      redirectTo: 'https://app.example.com/reset-password',
    });
    expect(state.status).toBe('success');
  });

  it('resets the password with the token from the link', async () => {
    auth.resetPassword.mockResolvedValue(ok({ status: true }));
    const url = await redirectOf(
      actions.resetPasswordAction(
        INITIAL_FORM_STATE,
        form({
          token: 'reset-token',
          password: 'new-long-password',
          confirmPassword: 'new-long-password',
        }),
      ),
    );
    expect(auth.resetPassword).toHaveBeenCalledWith({
      newPassword: 'new-long-password',
      token: 'reset-token',
    });
    expect(url).toBe('/login?reset=1');
  });

  it('rejects mismatched confirmations and invalid tokens', async () => {
    const mismatch = await actions.resetPasswordAction(
      INITIAL_FORM_STATE,
      form({ token: 't', password: 'new-long-password', confirmPassword: 'different-password' }),
    );
    expect(mismatch.fieldErrors?.confirmPassword).toMatch(/do not match/);

    auth.resetPassword.mockResolvedValue(fail('INVALID_TOKEN', 400));
    const invalid = await actions.resetPasswordAction(
      INITIAL_FORM_STATE,
      form({
        token: 'expired',
        password: 'new-long-password',
        confirmPassword: 'new-long-password',
      }),
    );
    expect(invalid.message).toMatch(/invalid or has expired/);
  });
});

describe('logout and session revocation', () => {
  it('revokes API tokens before ending the Neon Auth session', async () => {
    api.logout.mockImplementation(() => {
      calls.push('api.logout');
      return Promise.resolve();
    });
    auth.signOut.mockImplementation(() => {
      calls.push('neon.signOut');
      return Promise.resolve(ok({ success: true }));
    });
    const url = await redirectOf(actions.signOutAction());
    expect(api.logout).toHaveBeenCalledWith('current');
    expect(calls).toEqual(['api.logout', 'neon.signOut']);
    expect(url).toBe('/login?signedOut=1');
  });

  it('still ends the session if API revocation fails', async () => {
    api.logout.mockRejectedValue(new Error('API down'));
    auth.signOut.mockResolvedValue(ok({ success: true }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await redirectOf(actions.signOutAction());
    expect(auth.signOut).toHaveBeenCalled();
  });

  it('signs out everywhere: all API tokens and all Neon Auth sessions', async () => {
    api.logout.mockResolvedValue(undefined);
    auth.revokeSessions.mockResolvedValue(ok({ status: true }));
    auth.signOut.mockResolvedValue(ok({ success: true }));
    await redirectOf(actions.signOutEverywhereAction());
    expect(api.logout).toHaveBeenCalledWith('all');
    expect(auth.revokeSessions).toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
  });
});
