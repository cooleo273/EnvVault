'use server';

import {
  compareEnvironmentsInputSchema,
  createSnapshotInputSchema,
  type EffectiveConfiguration,
  type EnvironmentComparison,
  type ReadinessReport,
  readinessInputSchema,
  replaceValidationRulesInputSchema,
  type RestorePreview,
  restorePreviewInputSchema,
  type RestoreResult,
  restoreSnapshotInputSchema,
  type SnapshotDiff,
  snapshotDiffInputSchema,
  type SnapshotSummary,
  updateInheritanceInputSchema,
  type ValidationRule,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { failure, invalid, type SecretActionResult } from '@/features/secrets/action-helpers';
import { withApi } from '@/lib/api/server-api';
import { environmentPath, projectPath } from '@/lib/projects/server';
import './messages';

/**
 * Environment intelligence server actions. Arguments are client controlled;
 * the API authorizes each environment involved and validates again. No
 * action returns a secret value.
 */

type Result<T> = SecretActionResult<T>;

function refresh(workspaceId: string, projectId: string, environmentId: string): void {
  revalidatePath(environmentPath(workspaceId, projectId, environmentId), 'layout');
}

export async function compareEnvironmentsAction(
  workspaceId: string,
  projectId: string,
  input: unknown,
): Promise<Result<EnvironmentComparison>> {
  const parsed = compareEnvironmentsInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return {
      ok: true,
      data: await withApi((api) => api.compareEnvironments(workspaceId, projectId, parsed.data)),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function setBaseEnvironmentAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<Result<EffectiveConfiguration>> {
  const parsed = updateInheritanceInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const data = await withApi((api) =>
      api.setBaseEnvironment(workspaceId, projectId, environmentId, parsed.data.baseEnvironmentId),
    );
    refresh(workspaceId, projectId, environmentId);
    revalidatePath(projectPath(workspaceId, projectId), 'layout');
    return {
      ok: true,
      data,
      message: parsed.data.baseEnvironmentId ? 'Base environment saved.' : 'Inheritance removed.',
    };
  } catch (error) {
    return failure(error);
  }
}

export async function replaceValidationRulesAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<Result<ValidationRule[]>> {
  const parsed = replaceValidationRulesInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const data = await withApi((api) =>
      api.replaceValidationRules(workspaceId, projectId, environmentId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data, message: 'Validation rules saved.' };
  } catch (error) {
    return failure(error);
  }
}

export async function evaluateReadinessAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<Result<ReadinessReport>> {
  const parsed = readinessInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return {
      ok: true,
      data: await withApi((api) =>
        api.evaluateReadiness(workspaceId, projectId, environmentId, parsed.data),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function createSnapshotAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  input: unknown,
): Promise<Result<SnapshotSummary>> {
  const parsed = createSnapshotInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const data = await withApi((api) =>
      api.createSnapshot(workspaceId, projectId, environmentId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data, message: `Snapshot saved with ${String(data.entryCount)} variables.` };
  } catch (error) {
    return failure(error);
  }
}

export async function snapshotDiffAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  snapshotId: string,
  input: unknown,
): Promise<Result<SnapshotDiff>> {
  const parsed = snapshotDiffInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return {
      ok: true,
      data: await withApi((api) =>
        api.snapshotDiff(workspaceId, projectId, environmentId, snapshotId, parsed.data),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function previewRestoreAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  snapshotId: string,
  input: unknown,
): Promise<Result<RestorePreview>> {
  const parsed = restorePreviewInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return {
      ok: true,
      data: await withApi((api) =>
        api.previewSnapshotRestore(workspaceId, projectId, environmentId, snapshotId, parsed.data),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function restoreSnapshotAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  snapshotId: string,
  input: unknown,
): Promise<Result<RestoreResult>> {
  const parsed = restoreSnapshotInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const data = await withApi((api) =>
      api.restoreSnapshot(workspaceId, projectId, environmentId, snapshotId, parsed.data),
    );
    refresh(workspaceId, projectId, environmentId);
    return { ok: true, data, message: 'Snapshot restored.' };
  } catch (error) {
    return failure(error);
  }
}
