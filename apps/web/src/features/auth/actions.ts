'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { withApi } from '@/lib/api/server-api';
import { safeRedirectPath } from '@/lib/auth/redirect';
import { getAuth } from '@/lib/auth/server';
import { serverEnv } from '@/server-env';
import type { FormState } from '@/lib/form-state';

/**
 * Auth server actions built on the official Neon Auth Next.js SDK. They call
 * the same endpoints as Neon's own UI components (sign-in/up, email OTP
 * verification, request/reset password). EnvVault never sees or stores
 * password hashes: credentials are forwarded to Neon Auth only.
 *
 * Error messages are deliberately generic to avoid account enumeration.
 */

const PENDING_EMAIL_COOKIE = 'envvault.pending-verification';
/** Where to continue after email verification (validated again on use). */
const AFTER_VERIFICATION_COOKIE = 'envvault.after-verification';

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'The sign-in service is unavailable right now. Please try again in a moment.',
};

interface AuthError {
  code?: string | undefined;
  status?: number | undefined;
}

function isTransportError(error: AuthError): boolean {
  return (error.code?.startsWith('NETWORK_') ?? false) || (error.status ?? 0) >= 500;
}

/**
 * The Neon SDK normalizes Better Auth error codes (e.g. EMAIL_NOT_VERIFIED
 * becomes `email_not_confirmed`); accept both spellings.
 */
function isUnverifiedEmail(error: AuthError): boolean {
  return error.code === 'email_not_confirmed' || error.code === 'EMAIL_NOT_VERIFIED';
}

function isRateLimited(error: AuthError): boolean {
  return error.status === 429 || (error.code?.startsWith('over_') ?? false);
}

const RATE_LIMITED: FormState = {
  status: 'error',
  message: 'Too many attempts. Wait a minute and try again.',
};

function fieldErrors(error: z.ZodError): FormState {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return {
    status: 'error',
    message: 'Please correct the highlighted fields.',
    fieldErrors: errors,
  };
}

async function rememberPendingVerification(email: string): Promise<void> {
  (await cookies()).set(PENDING_EMAIL_COOKIE, email, {
    httpOnly: true,
    secure: serverEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
}

/** The email awaiting verification (from sign-up/sign-in), if any. */
export async function readPendingVerificationEmail(): Promise<string | null> {
  return (await cookies()).get(PENDING_EMAIL_COOKIE)?.value ?? null;
}

const email = z
  .email('Enter a valid email address')
  .max(320)
  .transform((v) => v.toLowerCase());
// Better Auth's defaults: 8-128 characters.
const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');

/* ------------------------------------------------------------------ Sign up */

const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100),
  email,
  password: newPassword,
  redirectTo: z.string().optional(),
});

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error);

  const { redirectTo, ...credentials } = parsed.data;
  const destination = safeRedirectPath(redirectTo);
  const { data, error } = await getAuth().signUp.email(credentials);
  if (error) {
    if (isTransportError(error)) return UNAVAILABLE;
    if (isRateLimited(error)) return RATE_LIMITED;
    return {
      status: 'error',
      message:
        'We could not create an account with these details. If you already have an account, sign in instead.',
    };
  }
  if (!data.user.emailVerified) {
    await rememberPendingVerification(parsed.data.email);
    (await cookies()).set(AFTER_VERIFICATION_COOKIE, destination, {
      httpOnly: true,
      secure: serverEnv().NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60,
    });
    redirect('/verify-email');
  }
  redirect(destination);
}

/* ------------------------------------------------------------------ Sign in */

const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(1024),
  redirectTo: z.string().optional(),
});

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error);

  const { error } = await getAuth().signIn.email({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    if (isTransportError(error)) return UNAVAILABLE;
    if (isRateLimited(error)) return RATE_LIMITED;
    if (isUnverifiedEmail(error)) {
      await rememberPendingVerification(parsed.data.email);
      redirect('/verify-email');
    }
    return { status: 'error', message: 'Incorrect email or password.' };
  }
  redirect(safeRedirectPath(parsed.data.redirectTo));
}

/* ------------------------------------------------------- Email verification */

const verifySchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, 'Enter the numeric code from the email'),
});

export async function verifyEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = verifySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error);
  const pendingEmail = await pendingOrSessionEmail();
  if (!pendingEmail) {
    return {
      status: 'error',
      message: 'Your verification session expired. Sign in again to get a new code.',
    };
  }

  const { data, error } = await getAuth().emailOtp.verifyEmail({
    email: pendingEmail,
    otp: parsed.data.otp,
  });
  if (error) {
    if (isTransportError(error)) return UNAVAILABLE;
    return { status: 'error', message: 'That code is invalid or has expired. Request a new code.' };
  }
  (await cookies()).delete({ name: PENDING_EMAIL_COOKIE, path: '/' });
  // With auto sign-in enabled Neon Auth starts a session; otherwise sign in.
  const jar = await cookies();
  const destination = safeRedirectPath(jar.get(AFTER_VERIFICATION_COOKIE)?.value);
  jar.delete({ name: AFTER_VERIFICATION_COOKIE, path: '/' });
  if ('token' in data && data.token) redirect(destination);
  redirect(`/login?verified=1&redirectTo=${encodeURIComponent(destination)}`);
}

export async function resendVerificationAction(_prev: FormState): Promise<FormState> {
  const pendingEmail = await pendingOrSessionEmail();
  if (!pendingEmail) {
    return {
      status: 'error',
      message: 'Your verification session expired. Sign in again to get a new code.',
    };
  }
  const { error } = await getAuth().emailOtp.sendVerificationOtp({
    email: pendingEmail,
    type: 'email-verification',
  });
  if (error && isTransportError(error)) return UNAVAILABLE;
  return { status: 'success', message: 'If a verification is pending, a new code is on its way.' };
}

async function pendingOrSessionEmail(): Promise<string | null> {
  const pending = await readPendingVerificationEmail();
  if (pending) return pending;
  const { data } = await getAuth().getSession();
  return data?.user && !data.user.emailVerified ? data.user.email : null;
}

/* ----------------------------------------------------------- Password reset */

export async function requestPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = z.object({ email }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error);

  const { error } = await getAuth().requestPasswordReset({
    email: parsed.data.email,
    // Must be a trusted domain in Neon Auth (localhost is allowed by default).
    redirectTo: `${serverEnv().APP_BASE_URL}/reset-password`,
  });
  if (error && isTransportError(error)) return UNAVAILABLE;
  // Same answer whether or not the account exists.
  return {
    status: 'success',
    message:
      'If an account exists for that address, a reset link is on its way. It expires in 15 minutes.',
  };
}

const resetSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export async function resetPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = resetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error);

  const { error } = await getAuth().resetPassword({
    newPassword: parsed.data.password,
    token: parsed.data.token,
  });
  if (error) {
    if (isTransportError(error)) return UNAVAILABLE;
    return {
      status: 'error',
      message: 'This reset link is invalid or has expired. Request a new one.',
    };
  }
  redirect('/login?reset=1');
}

/* ------------------------------------------------------------------ Sign out */

/**
 * Ends the session. Order matters: first the API revokes access tokens issued
 * until now (stateless JWTs would otherwise stay valid up to 15 minutes), then
 * Neon Auth ends the session and clears the cookies.
 */
export async function signOutAction(): Promise<void> {
  await revokeApiTokens('current');
  await getAuth().signOut();
  redirect('/login?signedOut=1');
}

/** Ends every Neon Auth session of this user and revokes all their API tokens. */
export async function signOutEverywhereAction(): Promise<void> {
  await revokeApiTokens('all');
  await getAuth().revokeSessions();
  await getAuth().signOut();
  redirect('/login?signedOut=1');
}

async function revokeApiTokens(scope: 'current' | 'all'): Promise<void> {
  try {
    await withApi((api) => api.logout(scope));
  } catch (error) {
    // Still end the Neon session: revocation failure must never keep a user signed in.
    // Server-side operational log: error class and code only, no user data or credentials.
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    // eslint-disable-next-line no-console
    console.warn('EnvVault API token revocation failed during sign-out', {
      error: error instanceof Error ? error.name : typeof error,
      code,
    });
  }
}
