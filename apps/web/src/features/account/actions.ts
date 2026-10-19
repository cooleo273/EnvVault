'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AUTH_ROUTES } from '@/config/routes';
import { clientWithCurrentToken, withApi } from '@/lib/api/server-api';
import type { EnvVaultClient } from '@envvault/sdk';
import { getAuth } from '@/lib/auth/server';
import type { ActionResult, FormState } from '@/lib/form-state';
import { listRawSessions } from './sessions';

/**
 * Account actions using Neon Auth's supported endpoints (`update-user`,
 * `change-password`, `revoke-session`, `revoke-other-sessions`). Neon Auth
 * owns credentials; EnvVault never sees password hashes. After a security
 * change the EnvVault API revokes access tokens already issued (they are
 * stateless JWTs valid for up to 15 minutes).
 */

interface AuthError {
  code?: string | undefined;
  status?: number | undefined;
}

const UNAVAILABLE = 'The account service is unavailable right now. Please try again in a moment.';

function isTransportError(error: AuthError): boolean {
  return (error.code?.startsWith('NETWORK_') ?? false) || (error.status ?? 0) >= 500;
}

function isRateLimited(error: AuthError): boolean {
  return error.status === 429 || (error.code?.startsWith('over_') ?? false);
}

function zodFieldErrors(error: z.ZodError): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors };
}

/** Best effort: the session change already happened in Neon Auth. */
async function revokeIssuedApiTokens(
  reason: 'password_changed' | 'sessions_revoked',
  client?: EnvVaultClient | null,
) {
  try {
    await (client ? client.revokeTokens(reason) : withApi((api) => api.revokeTokens(reason)));
  } catch (error) {
    // eslint-disable-next-line no-console -- server-side operational log; no secrets
    console.warn('EnvVault API token revocation failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/* ----------------------------------------------------------------- Profile */

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100, 'Use at most 100 characters'),
});

export async function updateProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = profileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodFieldErrors(parsed.error);
  const { error } = await getAuth().updateUser({ name: parsed.data.name });
  if (error) {
    if (isTransportError(error)) return { status: 'error', message: UNAVAILABLE };
    return { status: 'error', message: 'Your profile could not be updated.' };
  }
  revalidatePath('/', 'layout');
  return { status: 'success', message: 'Profile updated.' };
}

/* ---------------------------------------------------------------- Password */

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(1024),
    // Better Auth's defaults: 8-128 characters.
    newPassword: z
      .string()
      .min(8, 'Use at least 8 characters')
      .max(128, 'Use at most 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  });

export async function changePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = passwordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodFieldErrors(parsed.error);
  // Mint the API token first: the password change replaces the session cookie.
  const api = await clientWithCurrentToken();
  const { error } = await getAuth().changePassword({
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
    // Ends every other session in Neon Auth.
    revokeOtherSessions: true,
  });
  if (error) {
    if (isTransportError(error)) return { status: 'error', message: UNAVAILABLE };
    if (isRateLimited(error)) {
      return { status: 'error', message: 'Too many attempts. Wait a minute and try again.' };
    }
    return {
      status: 'error',
      message: 'Your current password is incorrect.',
      fieldErrors: { currentPassword: 'Incorrect password' },
    };
  }
  await revokeIssuedApiTokens('password_changed', api);
  revalidatePath('/settings/security');
  return {
    status: 'success',
    message: 'Password changed. Other devices were signed out.',
  };
}

/* ---------------------------------------------------------------- Sessions */

/**
 * Ends one other session. The browser only knows the session id; the token
 * that Neon Auth needs is looked up here, server-side, among the caller's
 * own sessions.
 */
export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  const { data: current } = await getAuth().getSession();
  if (!current?.session) redirect(AUTH_ROUTES.login);
  if (sessionId === current.session.id) {
    return { ok: false, message: 'Use “Sign out” to end the session on this device.' };
  }
  const target = (await listRawSessions()).find((s) => s.id === sessionId);
  if (!target?.token) return { ok: false, message: 'That session no longer exists.' };
  const { error } = await getAuth().revokeSession({ token: target.token });
  if (error) {
    return {
      ok: false,
      message: isTransportError(error) ? UNAVAILABLE : 'The session could not be ended.',
    };
  }
  await revokeIssuedApiTokens('sessions_revoked');
  revalidatePath('/settings/security');
  return { ok: true, message: 'Session ended.' };
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  const { error } = await getAuth().revokeOtherSessions();
  if (error) {
    return {
      ok: false,
      message: isTransportError(error) ? UNAVAILABLE : 'Sessions could not be ended.',
    };
  }
  await revokeIssuedApiTokens('sessions_revoked');
  revalidatePath('/settings/security');
  return { ok: true, message: 'All other sessions were signed out.' };
}
