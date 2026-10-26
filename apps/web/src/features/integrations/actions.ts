'use server';

import {
  createOidcTrustBindingInputSchema,
  type OidcBindingAttemptList,
  type OidcTrustBinding,
  updateOidcTrustBindingInputSchema,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { failure, invalid, type SecretActionResult } from '@/features/secrets/action-helpers';
import { withApi } from '@/lib/api/server-api';
import { projectPath } from '@/lib/projects/server';

/**
 * GitHub Actions trust binding actions. Ids and inputs come from the browser:
 * the API authorizes every call (service_identity permissions, the caller's
 * own access on each environment, protected environment rules, step up).
 * Calls are never retried automatically.
 */

const id = z.uuid();
const UNKNOWN = { ok: false as const, message: 'Not found.' };

function ids(...values: unknown[]): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    const parsed = id.safeParse(value);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

function refresh(workspaceId: string, projectId: string) {
  revalidatePath(`${projectPath(workspaceId, projectId)}/integrations/github-actions`);
}

async function call<T>(
  workspaceId: string,
  projectId: string,
  run: () => Promise<T>,
  message?: string,
): Promise<SecretActionResult<T>> {
  try {
    const data = await run();
    refresh(workspaceId, projectId);
    return { ok: true, data, ...(message ? { message } : {}) };
  } catch (error) {
    return failure(error);
  }
}

export async function createTrustBindingAction(
  workspaceId: unknown,
  projectId: unknown,
  input: unknown,
): Promise<SecretActionResult<OidcTrustBinding>> {
  const scope = ids(workspaceId, projectId);
  if (!scope) return UNKNOWN;
  const [ws, project] = scope as [string, string];
  const parsed = createOidcTrustBindingInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    ws,
    project,
    () => withApi((api) => api.createOidcTrustBinding(ws, project, parsed.data)),
    'Trust binding created. Matching workflows can now authenticate as this identity.',
  );
}

export async function updateTrustBindingAction(
  workspaceId: unknown,
  projectId: unknown,
  bindingId: unknown,
  input: unknown,
): Promise<SecretActionResult<OidcTrustBinding>> {
  const scope = ids(workspaceId, projectId, bindingId);
  if (!scope) return UNKNOWN;
  const [ws, project, binding] = scope as [string, string, string];
  const parsed = updateOidcTrustBindingInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(ws, project, () =>
    withApi((api) => api.updateOidcTrustBinding(ws, project, binding, parsed.data)),
  );
}

export async function setTrustBindingEnabledAction(
  workspaceId: unknown,
  projectId: unknown,
  bindingId: unknown,
  enabled: unknown,
): Promise<SecretActionResult<OidcTrustBinding>> {
  const scope = ids(workspaceId, projectId, bindingId);
  if (!scope || typeof enabled !== 'boolean') return UNKNOWN;
  const [ws, project, binding] = scope as [string, string, string];
  return call(
    ws,
    project,
    () =>
      withApi((api) =>
        enabled
          ? api.enableOidcTrustBinding(ws, project, binding)
          : api.disableOidcTrustBinding(ws, project, binding),
      ),
    enabled
      ? 'Trust binding enabled.'
      : 'Trust binding disabled. Its access tokens stopped working.',
  );
}

export async function deleteTrustBindingAction(
  workspaceId: unknown,
  projectId: unknown,
  bindingId: unknown,
): Promise<SecretActionResult<null>> {
  const scope = ids(workspaceId, projectId, bindingId);
  if (!scope) return UNKNOWN;
  const [ws, project, binding] = scope as [string, string, string];
  return call(
    ws,
    project,
    async () => {
      await withApi((api) => api.deleteOidcTrustBinding(ws, project, binding));
      return null;
    },
    'Trust binding deleted.',
  );
}

export async function trustBindingAttemptsAction(
  workspaceId: unknown,
  projectId: unknown,
  bindingId: unknown,
): Promise<SecretActionResult<OidcBindingAttemptList>> {
  const scope = ids(workspaceId, projectId, bindingId);
  if (!scope) return UNKNOWN;
  const [ws, project, binding] = scope as [string, string, string];
  try {
    return {
      ok: true,
      data: await withApi((api) => api.oidcTrustBindingAttempts(ws, project, binding)),
    };
  } catch (error) {
    return failure(error);
  }
}
