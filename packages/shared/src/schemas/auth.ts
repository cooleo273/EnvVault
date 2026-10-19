import { z } from 'zod';

/**
 * Machine-readable codes in the API error envelope (`error.code`) for
 * authentication and authorization failures.
 */
export const AUTH_ERROR_CODES = {
  /** No credentials supplied. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Token signature, issuer, audience, algorithm or claims are invalid. */
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** Token was issued before the user logged out / revoked sessions. */
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  /** The identity provider could not be reached to verify the token. */
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /** Authenticated, but lacks the required permission. */
  FORBIDDEN: 'FORBIDDEN',
  /** Sensitive action: re-verify credentials first (POST /auth/step-up). */
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  STEP_UP_FAILED: 'STEP_UP_FAILED',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/* ------------------------------------------------------------------ Session */

export const logoutInputSchema = z.object({
  /** `all` also ends every other session (sign out everywhere). */
  scope: z.enum(['current', 'all']).default('current'),
});
export type LogoutInput = z.infer<typeof logoutInputSchema>;

export const stepUpInputSchema = z.object({
  password: z.string().min(1).max(1024),
});
export type StepUpInput = z.infer<typeof stepUpInputSchema>;

export const stepUpStatusSchema = z.object({
  active: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
});
export type StepUpStatus = z.infer<typeof stepUpStatusSchema>;

/**
 * Self-revocation of API tokens after an account security change made with
 * Neon Auth (password change, ending other sessions). Tokens issued before
 * now are rejected; the current device simply mints a new one.
 */
export const revokeTokensInputSchema = z.object({
  reason: z.enum(['password_changed', 'sessions_revoked']),
});
export type RevokeTokensInput = z.infer<typeof revokeTokensInputSchema>;
