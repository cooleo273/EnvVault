'use server';

import {
  bulkActionInputSchema,
  type BulkResult,
  compareVersionsInputSchema,
  createSecretInputSchema,
  exportInputSchema,
  type ExportResult,
  importCommitInputSchema,
  type ImportPreview,
  importPreviewInputSchema,
  type ImportResult,
  rollbackInputSchema,
  type SecretSelection,
  type SecretType,
  type SecretVersionPage,
  SECRET_TYPES,
  updateSecretInputSchema,
  type VersionComparison,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AUTH_ROUTES } from '@/config/routes';
import { messageFor } from '@/features/workspaces/messages';
import { isApiError, withApi } from '@/lib/api/server-api';
import { environmentPath } from '@/lib/projects/server';
import './messages';

/**
 * Variable server actions. Every argument is client controlled: the API
 * authorizes each call against the caller's current membership, project role
 * and environment grants, and validates again. Values pass through here in
 * memory only; nothing is logged, cached or stored by the web server.
 */

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

function failure(error: unknown): {
  ok: false;
  code?: string;
  message: string;
  fieldErrors?: Record<string, string>;
} {
  if (isApiError(error) && SESSION_ENDED.includes(error.code)) redirect(AUTH_ROUTES.login);
  if (!isApiError(error)) return { ok: false, message: messageFor(undefined) };
  const field = FIELD_FOR_CODE[error.code];
  const message = messageFor(error.code);
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

function invalid(error: z.ZodError): SecretActionResult<never> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { ok: false, message: 'Please correct the highlighted fields.', fieldErrors };
}

function refresh(workspaceId: string, projectId: string, environmentId: string): void {
  revalidatePath(environmentPath(workspaceId, projectId, environmentId));
}

export async function createSecretAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<SecretActionResult<{ id: string }>> {
  const parsed = createSecretInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { id } = await withApi((api) =>
      api.createSecret(workspaceId, projectId, environmentId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data: { id }, message: `${parsed.data.key} added.` };
  } catch (error) {
    return failure(error);
  }
}

export async function updateSecretAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  input: unknown,
): Promise<SecretActionResult<{ revision: number }>> {
  const parsed = updateSecretInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const updated = await withApi((api) =>
      api.updateSecret(workspaceId, projectId, environmentId, secretId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data: { revision: updated.revision }, message: `${updated.key} saved.` };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteSecretAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  expectedRevision: number,
): Promise<SecretActionResult> {
  const revision = z.number().int().min(1).safeParse(expectedRevision);
  if (!revision.success) return invalid(revision.error);
  try {
    await withApi((api) =>
      api.deleteSecret(workspaceId, projectId, environmentId, secretId, revision.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return {
      ok: true,
      data: undefined,
      message: 'Variable deleted. You can restore it from Deleted.',
    };
  } catch (error) {
    return failure(error);
  }
}

export async function restoreSecretAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
): Promise<SecretActionResult> {
  try {
    const restored = await withApi((api) =>
      api.restoreSecret(workspaceId, projectId, environmentId, secretId),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data: undefined, message: `${restored.key} restored.` };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Decrypts one value for display. The API checks permissions (and step up in
 * protected environments) and audits the reveal; this action only relays the
 * result. Nothing is revalidated: the value must not enter any cached payload.
 */
export async function revealSecretAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
): Promise<SecretActionResult<{ value: string; version: number; type: SecretType }>> {
  try {
    const revealed = await withApi((api) =>
      api.revealSecret(workspaceId, projectId, environmentId, secretId),
    );
    return {
      ok: true,
      data: { value: revealed.value, version: revealed.version, type: revealed.type },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Confirms the password (step up) so protected values can be revealed for a while. */
export async function confirmPasswordAction(password: unknown): Promise<SecretActionResult> {
  const parsed = z.string().min(1, 'Enter your password').max(1024).safeParse(password);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await withApi((api) => api.stepUp(parsed.data));
    return { ok: true, data: undefined };
  } catch (error) {
    const result = failure(error);
    return isApiError(error, 'STEP_UP_FAILED')
      ? { ...result, fieldErrors: { password: 'Incorrect password.' } }
      : result;
  }
}

/* ----------------------------------------------------- Import and export */

export async function previewImportAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<SecretActionResult<ImportPreview>> {
  const parsed = importPreviewInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const preview = await withApi((api) =>
      api.previewSecretImport(workspaceId, projectId, environmentId, parsed.data),
    );
    return { ok: true, data: preview };
  } catch (error) {
    return failure(error);
  }
}

export async function importAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<SecretActionResult<ImportResult>> {
  const parsed = importCommitInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const result = await withApi((api) =>
      api.importSecrets(workspaceId, projectId, environmentId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Decrypted file content for a browser download. Like a reveal, nothing is
 * revalidated or cached; the caller turns it into a Blob and drops it.
 */
export async function exportAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<SecretActionResult<ExportResult>> {
  const parsed = exportInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const result = await withApi((api) =>
      api.exportSecrets(workspaceId, projectId, environmentId, parsed.data),
    );
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------ Bulk */

const selectionQuerySchema = z.object({
  q: z.string().max(100).optional(),
  type: z.array(z.enum(SECRET_TYPES)).optional(),
  category: z.array(z.string().max(64)).max(20).optional(),
  tag: z.string().max(32).optional(),
  status: z.enum(['active', 'deleted']).optional(),
});

export async function selectionAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  query: unknown,
): Promise<SecretActionResult<SecretSelection>> {
  const parsed = selectionQuerySchema.safeParse(query);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const selection = await withApi((api) =>
      api.secretSelection(workspaceId, projectId, environmentId, parsed.data),
    );
    return { ok: true, data: selection };
  } catch (error) {
    return failure(error);
  }
}

export async function bulkAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<SecretActionResult<BulkResult>> {
  const parsed = bulkActionInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const result = await withApi((api) =>
      api.bulkSecrets(workspaceId, projectId, environmentId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------ History */

export async function listVersionsAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  before?: number,
): Promise<SecretActionResult<SecretVersionPage>> {
  const cursor = z.number().int().min(1).optional().safeParse(before);
  if (!cursor.success) return invalid(cursor.error);
  try {
    const page = await withApi((api) =>
      api.listSecretVersions(workspaceId, projectId, environmentId, secretId, {
        ...(cursor.data === undefined ? {} : { before: cursor.data }),
        limit: 20,
      }),
    );
    return { ok: true, data: page };
  } catch (error) {
    return failure(error);
  }
}

export async function revealVersionAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  versionId: string,
): Promise<SecretActionResult<{ value: string; version: number }>> {
  const id = z.uuid().safeParse(versionId);
  if (!id.success) return invalid(id.error);
  try {
    const revealed = await withApi((api) =>
      api.revealSecretVersion(workspaceId, projectId, environmentId, secretId, id.data),
    );
    return { ok: true, data: { value: revealed.value, version: revealed.version } };
  } catch (error) {
    return failure(error);
  }
}

export async function compareVersionsAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  input: unknown,
): Promise<SecretActionResult<VersionComparison>> {
  const parsed = compareVersionsInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const comparison = await withApi((api) =>
      api.compareSecretVersions(workspaceId, projectId, environmentId, secretId, parsed.data),
    );
    return { ok: true, data: comparison };
  } catch (error) {
    return failure(error);
  }
}

export async function rollbackAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
  input: unknown,
): Promise<SecretActionResult<{ version: number | null; revision: number }>> {
  const parsed = rollbackInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const summary = await withApi((api) =>
      api.rollbackSecret(workspaceId, projectId, environmentId, secretId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return {
      ok: true,
      data: { version: summary.currentVersion, revision: summary.revision },
      message: `${summary.key} restored to an earlier value as version ${String(summary.currentVersion)}.`,
    };
  } catch (error) {
    return failure(error);
  }
}
