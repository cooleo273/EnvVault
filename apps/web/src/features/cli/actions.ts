'use server';

import { USER_CODE_PATTERN } from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { failure, type SecretActionResult } from '@/features/secrets/action-helpers';
import { withApi, withApiMutation } from '@/lib/api/server-api';

/** Approving a CLI sign in: the API also requires a recent password confirmation. */

function code(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return USER_CODE_PATTERN.test(normalized) ? normalized : null;
}

const INVALID = {
  ok: false as const,
  message: 'Enter the code shown in your terminal (8 letters).',
};

export async function approveCliLoginAction(userCode: unknown): Promise<SecretActionResult> {
  const value = code(userCode);
  if (!value) return INVALID;
  try {
    await withApiMutation((api) => api.approveCliLogin(value));
    revalidatePath('/settings/security');
    return { ok: true, data: undefined, message: 'The CLI is signed in. You can close this tab.' };
  } catch (error) {
    return failure(error);
  }
}

export async function denyCliLoginAction(userCode: unknown): Promise<SecretActionResult> {
  const value = code(userCode);
  if (!value) return INVALID;
  try {
    await withApiMutation((api) => api.denyCliLogin(value));
    return { ok: true, data: undefined, message: 'Sign in denied. The CLI was not signed in.' };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeCliSessionAction(sessionId: unknown): Promise<SecretActionResult> {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    return { ok: false, message: 'Unknown session' };
  }
  try {
    await withApi((api) => api.revokeCliSession(sessionId));
    revalidatePath('/settings/security');
    return { ok: true, data: undefined, message: 'CLI session ended.' };
  } catch (error) {
    return failure(error);
  }
}
