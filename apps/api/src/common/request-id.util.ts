import type { AuthenticatedRequest } from '../auth/principal.js';

/** The request id assigned by the logging middleware (for audit correlation). */
export function requestIdOf(request: AuthenticatedRequest): string | null {
  return typeof request.id === 'string' ? request.id : null;
}
