import { HttpStatus, Injectable } from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  type MaintenanceJobRecord,
  type RetentionCutoffs,
  type RetentionPolicyRecord,
  withTransaction,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  type MaintenanceJob,
  RETENTION_ERROR_CODES,
  RETENTION_LIMITS,
  type RetentionPolicy,
  type RetentionPolicyInput,
  type RetentionPreview,
} from '@envvault/shared';
import type { AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { countsOf, type RetentionRunParameters } from './retention-runner.js';

const DAY_MS = 86_400_000;

function toPolicy(record: RetentionPolicyRecord | null): RetentionPolicy {
  return {
    deletedSecretDays: record?.deletedSecretDays ?? null,
    versionKeepCount: record?.versionKeepCount ?? null,
    versionMinAgeDays: record?.versionMinAgeDays ?? null,
    snapshotDays: record?.snapshotDays ?? null,
    auditDays: record?.auditDays ?? null,
    includeProtected: record?.includeProtected ?? false,
    updatedAt: record?.updatedAt.toISOString() ?? null,
    updatedBy: record?.updatedBy ?? null,
  };
}

export function cutoffsOf(policy: RetentionPolicy, now: Date): RetentionCutoffs {
  const ago = (days: number | null) =>
    days === null ? null : new Date(now.getTime() - days * DAY_MS);
  return {
    deletedSecretsBefore: ago(policy.deletedSecretDays),
    versions:
      policy.versionKeepCount === null
        ? null
        : { keep: policy.versionKeepCount, before: ago(policy.versionMinAgeDays ?? 0) ?? now },
    snapshotsBefore: ago(policy.snapshotDays),
    auditBefore: ago(
      policy.auditDays === null ? null : Math.max(policy.auditDays, RETENTION_LIMITS.minAuditDays),
    ),
    includeProtected: policy.includeProtected,
  };
}

export function toJob(record: MaintenanceJobRecord): MaintenanceJob {
  return {
    id: record.id,
    kind: 'retention',
    status: record.status,
    counts: countsOf(record.progress),
    errorCode: record.errorCode,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    requestedBy: record.requestedBy,
  };
}

/**
 * Workspace retention. Changing or previewing a policy needs
 * `workspace:update`; starting a purge needs `workspace:delete`, a recent
 * password confirmation and the workspace slug typed out, because purged
 * rows cannot be brought back by EnvVault.
 */
@Injectable()
export class RetentionService {
  constructor(private readonly database: DatabaseService) {}

  async get(workspace: AuthorizedWorkspace): Promise<RetentionPolicy> {
    return toPolicy(
      await createRepositories(this.database.client).retention.get(workspace.scope.workspaceId),
    );
  }

  async update(
    principal: Principal,
    workspace: AuthorizedWorkspace,
    input: RetentionPolicyInput,
    requestId: string | null,
  ): Promise<RetentionPolicy> {
    const repos = createRepositories(this.database.client);
    const before = toPolicy(await repos.retention.get(workspace.scope.workspaceId));
    if (input.includeProtected && !before.includeProtected) {
      // Extending purges to protected environments is as sensitive as purging.
      if (!(await repos.authState.findActiveStepUpExpiry(principal.userId))) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          AUTH_ERROR_CODES.STEP_UP_REQUIRED,
          'Confirm your password to include protected environments',
        );
      }
    }
    await withTransaction(this.database.client, async (tx) => {
      const r = createRepositories(tx);
      await r.retention.upsert(workspace.scope.workspaceId, input, principal.userId);
      await r.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'retention.policy_updated',
        outcome: 'SUCCESS',
        resourceType: 'workspace',
        resourceId: workspace.scope.workspaceId,
        requestId,
        metadata: { ...input },
      });
    });
    return this.get(workspace);
  }

  async preview(workspace: AuthorizedWorkspace, now = new Date()): Promise<RetentionPreview> {
    const policy = await this.get(workspace);
    const counts = await createRepositories(this.database.client).retention.counts(
      workspace.scope.workspaceId,
      cutoffsOf(policy, now),
      RETENTION_LIMITS.previewCap,
    );
    return {
      counts,
      capped: Object.values(counts).some((n) => n >= RETENTION_LIMITS.previewCap),
      evaluatedAt: now.toISOString(),
    };
  }

  async start(
    principal: Principal,
    workspace: AuthorizedWorkspace,
    confirm: string,
    requestId: string | null,
    now = new Date(),
  ): Promise<MaintenanceJob> {
    const repos = createRepositories(this.database.client);
    const detail = await repos.workspaces.getDetail(workspace.scope);
    if (confirm !== detail?.slug) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONFIRMATION_MISMATCH',
        'Type the workspace URL name exactly to confirm',
      );
    }
    const policy = await this.get(workspace);
    const c = cutoffsOf(policy, now);
    if (!c.deletedSecretsBefore && !c.versions && !c.snapshotsBefore && !c.auditBefore) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        RETENTION_ERROR_CODES.RETENTION_POLICY_EMPTY,
        'The retention policy keeps everything, so there is nothing to purge',
      );
    }
    const parameters: RetentionRunParameters = {
      deletedSecretsBefore: c.deletedSecretsBefore?.toISOString() ?? null,
      versions: c.versions
        ? { keep: c.versions.keep, before: c.versions.before.toISOString() }
        : null,
      snapshotsBefore: c.snapshotsBefore?.toISOString() ?? null,
      auditBefore: c.auditBefore?.toISOString() ?? null,
      includeProtected: c.includeProtected,
    };
    try {
      const job = await withTransaction(this.database.client, async (tx) => {
        const r = createRepositories(tx);
        const created = await r.maintenanceJobs.enqueue(
          workspace.scope.workspaceId,
          'retention',
          { ...parameters },
          principal.userId,
        );
        await r.audit.append({
          workspaceId: workspace.scope.workspaceId,
          actorUserId: principal.userId,
          action: 'retention.purge_requested',
          outcome: 'SUCCESS',
          resourceType: 'workspace',
          resourceId: workspace.scope.workspaceId,
          requestId,
          metadata: {
            jobId: created.id,
            ...parameters,
            versions: parameters.versions ? parameters.versions.keep : null,
          },
        });
        return created;
      });
      return toJob(job);
    } catch (error) {
      if (getConstraintViolation(error)?.constraint === 'maintenance_jobs_active_key') {
        throw new ApiException(
          HttpStatus.CONFLICT,
          RETENTION_ERROR_CODES.RETENTION_RUN_ACTIVE,
          'A retention run is already queued or running for this workspace',
        );
      }
      throw error;
    }
  }

  async job(workspace: AuthorizedWorkspace, id: string): Promise<MaintenanceJob | null> {
    const record = await createRepositories(this.database.client).maintenanceJobs.get(
      workspace.scope.workspaceId,
      id,
    );
    return record ? toJob(record) : null;
  }

  async jobs(workspace: AuthorizedWorkspace): Promise<MaintenanceJob[]> {
    const records = await createRepositories(this.database.client).maintenanceJobs.list(
      workspace.scope.workspaceId,
      20,
    );
    return records.map(toJob);
  }
}
