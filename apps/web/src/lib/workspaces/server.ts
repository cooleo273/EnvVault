import 'server-only';
import type { MeResponse, WorkspaceDetail } from '@envvault/shared';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { AUTH_ROUTES } from '@/config/routes';
import { isApiError, withApi } from '@/lib/api/server-api';

const SESSION_ENDED = ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID'];

/**
 * Maps API failures to navigation for Server Components: an ended session
 * goes to sign-in (returning here afterwards), 404 renders the not-found
 * page. Anything else propagates to the nearest error boundary.
 */
export function handleApiFailure(error: unknown, returnTo: string): never {
  if (isApiError(error) && SESSION_ENDED.includes(error.code)) {
    redirect(`${AUTH_ROUTES.login}?redirectTo=${encodeURIComponent(returnTo)}`);
  }
  if (isApiError(error, 'NOT_FOUND')) notFound();
  throw error;
}

/** `GET /users/me`, deduplicated per request. Null if the API is unreachable. */
export const getMe = cache(async (): Promise<MeResponse | null> => {
  try {
    return await withApi((api) => api.me());
  } catch (error) {
    if (isApiError(error) && SESSION_ENDED.includes(error.code)) {
      redirect(AUTH_ROUTES.login);
    }
    return null;
  }
});

/** Workspace detail for the caller, deduplicated per request (404 for non-members). */
export const getWorkspace = cache(async (workspaceId: string): Promise<WorkspaceDetail> => {
  try {
    return await withApi((api) => api.getWorkspace(workspaceId));
  } catch (error) {
    handleApiFailure(error, `/workspaces/${workspaceId}`);
  }
});
