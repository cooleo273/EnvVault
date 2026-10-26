import { z } from 'zod';

export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * Uniform error envelope returned by the API for every non-2xx response.
 * It never contains stack traces, internal messages or request payloads.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    statusCode: z.number().int().min(400).max(599),
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().optional(),
    issues: z.array(validationIssueSchema).optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * Codes any route can answer with, besides the domain catalogs
 * (AUTH_ERROR_CODES, SECRET_ERROR_CODES and so on). Clients branch on
 * `error.code`, never on `message`.
 */
export const GENERAL_ERROR_CODES = {
  /** 400: malformed request, or body or query not matching the schema (see `error.issues`). */
  BAD_REQUEST: 'BAD_REQUEST',
  /** 422: well formed, but not acceptable (for example an expiry in the past). */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Missing, or outside the caller's access: the two are deliberately indistinguishable. */
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  /** Rate limited; wait `Retry-After` seconds. */
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  /** Limits cannot be checked (shared store down); sensitive actions pause. */
  RATE_LIMIT_UNAVAILABLE: 'RATE_LIMIT_UNAVAILABLE',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  /** The same key was used with a different request. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The first request with this key is still running; retry shortly. */
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
