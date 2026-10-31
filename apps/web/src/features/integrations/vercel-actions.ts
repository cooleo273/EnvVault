'use server';

import {
  createMappingInputSchema,
  createVercelConnectionInputSchema,
  type CustomEnvironmentList,
  type IntegrationConnection,
  type IntegrationMapping,
  type ProviderProjectList,
  replaceCredentialInputSchema,
  syncInputSchema,
  type SyncJob,
  type SyncJobList,
  type SyncPlan,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { failure, invalid, type SecretActionResult } from '@/features/secrets/action-helpers';
import { SYNC_TIMEOUT_MS, withApi } from '@/lib/api/server-api';
import { projectPath } from '@/lib/projects/server';

/**
 * Vercel integration actions. Ids and inputs come from the browser; the API
 * authorizes every call (integration permissions, secret:export for syncs,
 * step up). The access token passes through once to the API and is never
 * returned, logged or cached. Calls are never retried automatically.
 */

const id = z.uuid();
const UNKNOWN = { ok: false as const, message: 'Not found.' };
type Result<T> = Promise<SecretActionResult<T>>;

function ids(...values: unknown[]): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    const parsed = id.safeParse(value);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

async function call<T>(
  scope: [string, string],
  run: () => Promise<T>,
  message?: string,
): Result<T> {
  try {
    const data = await run();
    revalidatePath(`${projectPath(scope[0], scope[1])}/integrations/vercel`);
    return { ok: true, data, ...(message ? { message } : {}) };
  } catch (error) {
    return failure(error);
  }
}

export async function connectVercelAction(
  workspaceId: unknown,
  projectId: unknown,
  input: unknown,
): Result<IntegrationConnection> {
  const scope = ids(workspaceId, projectId) as [string, string] | null;
  if (!scope) return UNKNOWN;
  const parsed = createVercelConnectionInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    scope,
    () => withApi((api) => api.connectVercel(scope[0], scope[1], parsed.data)),
    'Vercel connected. Link a Vercel project next.',
  );
}

export async function replaceVercelTokenAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  input: unknown,
): Result<IntegrationConnection> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  const parsed = replaceCredentialInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    [ws, project],
    () =>
      withApi((api) => api.replaceIntegrationToken(ws, project, integration, parsed.data.token)),
    'Token replaced.',
  );
}

export async function checkVercelAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
): Result<IntegrationConnection> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  return call(
    [ws, project],
    () => withApi((api) => api.checkIntegration(ws, project, integration)),
    'Connection works.',
  );
}

export async function setVercelEnabledAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  enabled: unknown,
): Result<IntegrationConnection> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope || typeof enabled !== 'boolean') return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  return call(
    [ws, project],
    () => withApi((api) => api.setIntegrationEnabled(ws, project, integration, enabled)),
    enabled ? 'Integration enabled.' : 'Integration disabled.',
  );
}

export async function disconnectVercelAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
): Result<null> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  return call(
    [ws, project],
    async () => {
      await withApi((api) => api.disconnectIntegration(ws, project, integration));
      return null;
    },
    'Disconnected. Variables already in Vercel were left there.',
  );
}

export async function vercelProjectsAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  search: unknown,
): Result<ProviderProjectList> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  const term = typeof search === 'string' ? search.slice(0, 100) : undefined;
  try {
    return {
      ok: true,
      data: await withApi((api) => api.vercelProjects(ws, project, integration, term)),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function linkVercelProjectAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  vercelProjectId: unknown,
): Result<IntegrationConnection> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (
    !scope ||
    typeof vercelProjectId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(vercelProjectId)
  ) {
    return UNKNOWN;
  }
  const [ws, project, integration] = scope as [string, string, string];
  return call(
    [ws, project],
    () => withApi((api) => api.linkVercelProject(ws, project, integration, vercelProjectId)),
    'Vercel project linked.',
  );
}

export async function customEnvironmentsAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
): Result<CustomEnvironmentList> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  try {
    return {
      ok: true,
      data: await withApi((api) => api.vercelCustomEnvironments(ws, project, integration)),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function createMappingAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  input: unknown,
): Result<IntegrationMapping> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  const parsed = createMappingInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    [ws, project],
    () => withApi((api) => api.createIntegrationMapping(ws, project, integration, parsed.data)),
    'Mapping added. Nothing is copied until you preview and confirm a synchronisation.',
  );
}

export async function deleteMappingAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  mappingId: unknown,
): Result<null> {
  const scope = ids(workspaceId, projectId, integrationId, mappingId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration, mapping] = scope as [string, string, string, string];
  return call(
    [ws, project],
    async () => {
      await withApi((api) => api.deleteIntegrationMapping(ws, project, integration, mapping));
      return null;
    },
    'Mapping removed. Variables already in Vercel were left there.',
  );
}

export async function previewSyncAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  mappingId: unknown,
): Result<SyncPlan> {
  const scope = ids(workspaceId, projectId, integrationId, mappingId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration, mapping] = scope as [string, string, string, string];
  try {
    return {
      ok: true,
      data: await withApi((api) => api.previewSync(ws, project, integration, mapping)),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function runSyncAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
  mappingId: unknown,
  input: unknown,
): Result<SyncJob> {
  const scope = ids(workspaceId, projectId, integrationId, mappingId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration, mapping] = scope as [string, string, string, string];
  const parsed = syncInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call([ws, project], () =>
    withApi((api) => api.runSync(ws, project, integration, mapping, parsed.data), SYNC_TIMEOUT_MS),
  );
}

export async function syncJobsAction(
  workspaceId: unknown,
  projectId: unknown,
  integrationId: unknown,
): Result<SyncJobList> {
  const scope = ids(workspaceId, projectId, integrationId);
  if (!scope) return UNKNOWN;
  const [ws, project, integration] = scope as [string, string, string];
  try {
    return { ok: true, data: await withApi((api) => api.syncJobs(ws, project, integration)) };
  } catch (error) {
    return failure(error);
  }
}
