import 'server-only';
import { redirect } from 'next/navigation';
import type { z } from 'zod';
import { AUTH_ROUTES } from '@/config/routes';
import { API_ERROR_MESSAGES, messageFor } from '@/features/workspaces/messages';
import { isApiError } from '@/lib/api/server-api';
import './messages';

/** Shared by the secret and environment intelligence server actions. */
const SESSION_ENDED = ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID'];

export type SecretActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; code?: string; message: string; fieldErrors?: Record<string, string> };

/** Field the API error code belongs to, so the form can point at it. */
const FIELD_FOR_CODE: Record<string, string> = {
  SECRET_IMPORT_TOO_LARGE: 'content',
  SECRET_KEY_TAKEN: 'key',
  SECRET_VALUE_REQUIRED: 'value',
};

export function failure(error: unknown): {
  ok: false;
  code?: string;
  message: string;
  fieldErrors?: Record<string, string>;
} {
  if (isApiError(error) && SESSION_ENDED.includes(error.code)) redirect(AUTH_ROUTES.login);
  if (!isApiError(error)) return { ok: false, message: messageFor(undefined) };
  const field = FIELD_FOR_CODE[error.code];
  // API messages are client safe by contract; unmapped 4xx codes keep theirs.
  const message =
    API_ERROR_MESSAGES[error.code] ??
    (error.statusCode < 500 && error.message ? error.message : messageFor(error.code));
  const issues = error.issues?.filter((issue) => issue.path !== '');
  return {
    ok: false,
    code: error.code,
    message,
    ...(field
      ? { fieldErrors: { [field]: message } }
      : issues?.length
        ? {
            fieldErrors: Object.fromEntries(
              issues.map((issue) => [issue.path.split('.')[0] ?? 'form', issue.message]),
            ),
          }
        : {}),
  };
}

export function invalid(error: z.ZodError): SecretActionResult<never> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { ok: false, message: 'Please correct the highlighted fields.', fieldErrors };
}
