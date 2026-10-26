'use server';

import {
  activityQuerySchema,
  createMachineGrantInputSchema,
  createMachineIdentityInputSchema,
  createServiceCredentialInputSchema,
  disableMachineIdentityInputSchema,
  type IssuedServiceCredential,
  type MachineActivityPage,
  type MachineIdentitySummary,
  revokeServiceCredentialInputSchema,
  rotateServiceCredentialInputSchema,
  type ServiceCredential,
  updateMachineIdentityInputSchema,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { failure, invalid, type SecretActionResult } from '@/features/secrets/action-helpers';
import { withApi } from '@/lib/api/server-api';
import { projectPath } from '@/lib/projects/server';

/**
 * Machine identity actions. Ids and inputs come from the browser: the API
 * authorizes every call (service_identity permissions, environment grants,
 * step up). Calls are never retried automatically: issuing twice would
 * create two credentials. Issued tokens pass through once and are not
 * logged or cached.
 */

const id = z.uuid();

function paths(workspaceId: string, projectId: string, identityId?: string) {
  const base = `${projectPath(workspaceId, projectId)}/machines`;
  revalidatePath(base);
  if (identityId) revalidatePath(`${base}/${identityId}`);
}

function ids(...values: unknown[]): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    const parsed = id.safeParse(value);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

const UNKNOWN = { ok: false as const, message: 'Not found.' };

async function call<T>(
  run: () => Promise<T>,
  done: () => void,
  message?: string,
): Promise<SecretActionResult<T>> {
  try {
    const data = await run();
    done();
    return { ok: true, data, ...(message ? { message } : {}) };
  } catch (error) {
    return failure(error);
  }
}

export async function createMachineIdentityAction(
  workspaceId: unknown,
  projectId: unknown,
  input: unknown,
): Promise<SecretActionResult<MachineIdentitySummary>> {
  const scope = ids(workspaceId, projectId);
  if (!scope) return UNKNOWN;
  const [ws, project] = scope as [string, string];
  const parsed = createMachineIdentityInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () => withApi((api) => api.createMachineIdentity(ws, project, parsed.data)),
    () => {
      paths(ws, project);
    },
    'Machine identity created. It has no access until you grant it an environment.',
  );
}

export async function updateMachineIdentityAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  input: unknown,
): Promise<SecretActionResult<MachineIdentitySummary>> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  const parsed = updateMachineIdentityInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () => withApi((api) => api.updateMachineIdentity(ws, project, identity, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
    'Saved.',
  );
}

export async function setMachineIdentityEnabledAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  enabled: boolean,
  reason?: unknown,
): Promise<SecretActionResult<MachineIdentitySummary>> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  if (enabled) {
    return call(
      () => withApi((api) => api.enableMachineIdentity(ws, project, identity)),
      () => {
        paths(ws, project, identity);
      },
      'Enabled. Issue or reuse a credential to authenticate again.',
    );
  }
  const parsed = disableMachineIdentityInputSchema.safeParse(
    typeof reason === 'string' && reason.trim() !== '' ? { reason } : {},
  );
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () => withApi((api) => api.disableMachineIdentity(ws, project, identity, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
    'Disabled. Its access tokens stopped working.',
  );
}

export async function retireMachineIdentityAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
): Promise<SecretActionResult> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  return call(
    async () => {
      await withApi((api) => api.retireMachineIdentity(ws, project, identity));
      return undefined;
    },
    () => {
      paths(ws, project, identity);
    },
    'Retired. Its credentials are revoked and its grants removed.',
  );
}

export async function issueServiceCredentialAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  input: unknown,
): Promise<SecretActionResult<IssuedServiceCredential>> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  const parsed = createServiceCredentialInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () => withApi((api) => api.issueServiceCredential(ws, project, identity, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
  );
}

export async function rotateServiceCredentialAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  credentialId: unknown,
  input: unknown,
): Promise<SecretActionResult<IssuedServiceCredential>> {
  const scope = ids(workspaceId, projectId, identityId, credentialId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity, credential] = scope as [string, string, string, string];
  const parsed = rotateServiceCredentialInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () =>
      withApi((api) => api.rotateServiceCredential(ws, project, identity, credential, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
  );
}

export async function revokeServiceCredentialAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  credentialId: unknown,
  reason: unknown,
): Promise<SecretActionResult<ServiceCredential>> {
  const scope = ids(workspaceId, projectId, identityId, credentialId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity, credential] = scope as [string, string, string, string];
  const parsed = revokeServiceCredentialInputSchema.safeParse(
    typeof reason === 'string' && reason.trim() !== '' ? { reason } : {},
  );
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () =>
      withApi((api) => api.revokeServiceCredential(ws, project, identity, credential, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
    'Credential revoked. Tokens issued from it stopped working.',
  );
}

export async function grantMachineAccessAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  input: unknown,
): Promise<SecretActionResult<MachineIdentitySummary>> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  const parsed = createMachineGrantInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return call(
    () => withApi((api) => api.grantMachineAccess(ws, project, identity, parsed.data)),
    () => {
      paths(ws, project, identity);
    },
    'Access updated.',
  );
}

export async function removeMachineGrantAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  grantId: unknown,
): Promise<SecretActionResult<MachineIdentitySummary>> {
  const scope = ids(workspaceId, projectId, identityId, grantId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity, grant] = scope as [string, string, string, string];
  return call(
    () => withApi((api) => api.removeMachineGrant(ws, project, identity, grant)),
    () => {
      paths(ws, project, identity);
    },
    'Grant removed.',
  );
}

export async function machineActivityAction(
  workspaceId: unknown,
  projectId: unknown,
  identityId: unknown,
  cursor: unknown,
): Promise<SecretActionResult<MachineActivityPage>> {
  const scope = ids(workspaceId, projectId, identityId);
  if (!scope) return UNKNOWN;
  const [ws, project, identity] = scope as [string, string, string];
  const query = activityQuerySchema.safeParse(typeof cursor === 'string' ? { cursor } : {});
  if (!query.success) return invalid(query.error);
  return call(
    () => withApi((api) => api.machineIdentityActivity(ws, project, identity, query.data)),
    () => undefined,
  );
}
