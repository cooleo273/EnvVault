import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  type IntegrationConnectionRecord,
  type MappingRecord,
  type Repositories,
  type SyncJobRecord,
} from '@envvault/database';
import {
  INTEGRATION_ERROR_CODES,
  INTEGRATION_LIMITS,
  type SyncJob,
  type SyncJobList,
  type SyncPlan,
  type syncInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import {
  EnvironmentAccessService,
  type ProjectCaller,
} from '../intelligence/environment-access.service.js';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import { IntegrationsService } from './integrations.service.js';
import { decide, type MappingSlot, type PlannedItem, planSync } from './sync-plan.js';
import { ProviderError, type VariableWrite, type VercelClient } from './vercel-client.js';

type SyncInput = z.output<typeof syncInputSchema>;
type Outcome = 'written' | 'removed' | 'unchanged' | 'skipped' | 'failed' | 'not_attempted';
interface ItemResult {
  key: string;
  action: PlannedItem['action'];
  outcome: Outcome;
  errorCode: string | null;
}

const STALE_AFTER_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [500, 1500];
const COMMENT = 'Managed by EnvVault. Edit it in EnvVault, not here.';
const fail = (status: HttpStatus, code: string, message: string) =>
  new ApiException(status, code, message);
const iso = (d: Date | null) => d?.toISOString() ?? null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Previewing and running a synchronisation of one mapping: EnvVault's values
 * are copied to Vercel, where they leave EnvVault's encryption boundary. A run
 * is always started by a person, is confirmed against the previewed plan, and
 * writes one variable per request, so a failure leaves a precise partial
 * result that a later run picks up safely (Vercel offers no atomic batch).
 */
@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly integrations: IntegrationsService,
    private readonly access: EnvironmentAccessService,
    private readonly vault: SecretVault,
    private readonly limiter: SensitiveRateLimiter,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  private async mapping(caller: ProjectCaller, connectionId: string, mappingId: string) {
    const connection = await this.integrations.connection(caller, connectionId);
    const mapping = await this.repos.integrations.getMapping(
      caller.project.scope,
      connectionId,
      mappingId,
    );
    if (!mapping || mapping.environment.deletedAt) {
      throw fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    }
    return { connection, mapping };
  }

  private async environment(
    caller: ProjectCaller,
    mapping: MappingRecord,
    permissions: string[],
    attempted: string,
  ): Promise<AuthorizedEnvironment> {
    const environment = await this.access.environment(caller, mapping.environment.id);
    if (!environment) throw fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    const missing = permissions.filter((p) => !environment.permissions.has(p));
    if (missing.length > 0) {
      await this.repos.audit.append({
        workspaceId: caller.project.scope.workspaceId,
        projectId: caller.project.scope.projectId,
        environmentId: mapping.environment.id,
        actorUserId: caller.principal.userId,
        action: 'integration.sync_refused',
        outcome: 'DENIED',
        resourceType: 'integration',
        resourceId: mapping.integrationConnectionId,
        requestId: caller.requestId,
        metadata: { mappingId: mapping.id, attempted, missing },
      });
      throw fail(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        environment.isProtected
          ? `This environment is protected. ${missing.join(' and ')} must be granted to you on it directly.`
          : `You need ${missing.join(' and ')} on this environment`,
      );
    }
    return environment;
  }

  private slot(mapping: MappingRecord): MappingSlot {
    return {
      target: mapping.target,
      gitBranch: mapping.gitBranch,
      customEnvironmentId: mapping.customEnvironmentId,
    };
  }

  private async plan(
    caller: ProjectCaller,
    connection: IntegrationConnectionRecord,
    mapping: MappingRecord,
    environment: AuthorizedEnvironment,
    client: VercelClient,
  ) {
    const project = this.integrations.linkedProject(connection);
    const repos = this.repos;
    const source = (
      await repos.secretBulk.variables(environment.scope, INTEGRATION_LIMITS.maxSyncVariables)
    ).filter((v) => !v.deleted && v.currentVersionId !== null);
    if (source.length > INTEGRATION_LIMITS.maxSyncVariables) {
      throw fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VALIDATION_FAILED',
        `An environment can synchronise at most ${String(INTEGRATION_LIMITS.maxSyncVariables)} variables`,
      );
    }
    let provider;
    try {
      provider = await client.variables(project.id);
    } catch (error) {
      return this.integrations.providerError(caller, connection.id, error);
    }
    const managed = await repos.integrations.managedVariables(mapping.id);
    return {
      project,
      plan: planSync(
        this.slot(mapping),
        source.map((v) => ({
          secretId: v.id,
          key: v.key,
          versionId: v.currentVersionId,
          type: v.type,
        })),
        provider,
        managed,
      ),
    };
  }

  private confirmation(mapping: MappingRecord, environment: AuthorizedEnvironment) {
    return {
      protectedEnvironment: environment.isProtected,
      // A custom environment can be of type production too; treat it like Production.
      production: mapping.target === 'PRODUCTION' || mapping.customEnvironmentSlug === 'production',
    };
  }

  async preview(caller: ProjectCaller, connectionId: string, mappingId: string): Promise<SyncPlan> {
    const { connection, mapping } = await this.mapping(caller, connectionId, mappingId);
    const environment = await this.environment(
      caller,
      mapping,
      ['secret:list'],
      'integration.previewed',
    );
    const client = await this.integrations.client(caller.project.scope, connection);
    const { plan } = await this.plan(caller, connection, mapping, environment, client);
    const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, remove: 0 };
    for (const item of plan.items) counts[item.action] += 1;
    return {
      mappingId,
      planHash: plan.hash,
      items: plan.items.map(({ key, action, conflict, needsOverwrite, needsRemoval }) => ({
        key,
        action,
        conflict,
        needsOverwrite,
        needsRemoval,
      })),
      counts,
      unrelated: plan.unrelated,
      requiresConfirmation: this.confirmation(mapping, environment),
    };
  }

  async sync(
    caller: ProjectCaller,
    connectionId: string,
    mappingId: string,
    input: SyncInput,
  ): Promise<SyncJob> {
    const { connection, mapping } = await this.mapping(caller, connectionId, mappingId);
    // Copying values out of EnvVault is an export: the same permissions apply.
    const environment = await this.environment(
      caller,
      mapping,
      ['secret:read', 'secret:export'],
      'integration.synced',
    );
    const needs = this.confirmation(mapping, environment);
    if (
      (needs.protectedEnvironment && !input.confirmProtected) ||
      (needs.production && !input.confirmProduction)
    ) {
      throw fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        INTEGRATION_ERROR_CODES.SYNC_CONFIRMATION_REQUIRED,
        'Confirm copying a protected environment or to Vercel Production before synchronising',
      );
    }
    const client = await this.integrations.client(caller.project.scope, connection);
    await this.limiter.consume({ userId: caller.principal.userId, action: 'integration-sync' });

    const now = new Date();
    const repos = this.repos;
    await repos.integrations.failStaleJobs(
      mappingId,
      new Date(now.getTime() - STALE_AFTER_MS),
      now,
    );
    let jobId: string;
    try {
      jobId = await repos.integrations.startJob({
        workspaceId: caller.project.scope.workspaceId,
        projectId: caller.project.scope.projectId,
        connectionId,
        environmentId: mapping.environment.id,
        mappingId,
        requestedById: caller.principal.userId,
        planHash: input.planHash,
        now,
      });
    } catch (error) {
      if (getConstraintViolation(error)?.constraint === 'integration_sync_jobs_active_key') {
        throw fail(
          HttpStatus.CONFLICT,
          INTEGRATION_ERROR_CODES.SYNC_IN_PROGRESS,
          'A synchronisation of this mapping is already running',
        );
      }
      throw error;
    }

    const finish = async (
      status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED',
      results: ItemResult[],
      error: { code: string; message: string } | null,
      retryAfterSeconds: number | null = null,
    ) => {
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      const written = (counts.written ?? 0) + (counts.removed ?? 0);
      const finishedAt = new Date();
      await repos.integrations.finishJob(jobId, {
        status,
        summary: { counts, items: results, retryAfterSeconds, redeployRequired: written > 0 },
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        now: finishedAt,
      });
      if (written > 0) {
        await repos.integrations.markMappingSynced(mappingId, finishedAt);
        await repos.integrations.updateConnection(caller.project.scope, connectionId, {
          lastSyncedAt: finishedAt,
        });
      }
      await repos.audit.append({
        workspaceId: caller.project.scope.workspaceId,
        projectId: caller.project.scope.projectId,
        environmentId: mapping.environment.id,
        actorUserId: caller.principal.userId,
        action: 'integration.synced',
        outcome: status === 'SUCCEEDED' ? 'SUCCESS' : 'FAILURE',
        resourceType: 'integration',
        resourceId: connectionId,
        requestId: caller.requestId,
        metadata: {
          jobId,
          mappingId,
          status,
          target: mapping.target,
          written: counts.written ?? 0,
          removed: counts.removed ?? 0,
          failed: counts.failed ?? 0,
          skipped: counts.skipped ?? 0,
          errorCode: error?.code ?? null,
        },
      });
      const job = await repos.integrations.getJob(caller.project.scope, jobId);
      if (!job) throw fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
      return this.present(job);
    };

    let plan: Awaited<ReturnType<IntegrationSyncService['plan']>>;
    try {
      plan = await this.plan(caller, connection, mapping, environment, client);
    } catch (error) {
      await finish('FAILED', [], {
        code: error instanceof ApiException ? error.code : 'FAILED',
        message: 'The plan could not be computed',
      });
      throw error;
    }
    if (plan.plan.hash !== input.planHash) {
      await finish('CANCELLED', [], {
        code: INTEGRATION_ERROR_CODES.SYNC_PLAN_CHANGED,
        message: 'The plan changed after the preview',
      });
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.SYNC_PLAN_CHANGED,
        'Something changed in EnvVault or Vercel since the preview. Preview again and confirm the new plan.',
      );
    }

    const decisions = decide(plan.plan.items, input);
    const needValues = decisions.filter(
      (d) => d.operation === 'create' || d.operation === 'update',
    );
    const ctx = this.access.context(caller, environment);
    const values = new Map<string, string>();
    try {
      const ids = needValues.flatMap((d) => (d.item.secretId ? [d.item.secretId] : []));
      if (ids.length > 0) {
        const rows = await repos.secretBulk.forExport(
          environment.scope,
          ids,
          INTEGRATION_LIMITS.maxSyncVariables,
        );
        for (const row of rows) {
          if (!row.stored) continue;
          values.set(
            row.id,
            await this.vault.open(ctx, row.id, row.stored, {
              key: row.key,
              attempted: 'integration.synced',
            }),
          );
        }
        // Recorded before anything leaves EnvVault; refused if the access cannot be recorded.
        await this.vault.auditRead(
          ctx,
          'integration.values_exported',
          environment.scope.environmentId,
          { provider: 'vercel', jobId, mappingId, target: mapping.target, count: values.size },
          'environment',
          [...values.keys()],
        );
      }
    } catch (error) {
      values.clear();
      await finish('FAILED', [], {
        code: error instanceof ApiException ? error.code : 'FAILED',
        message: 'Values could not be read',
      });
      throw error;
    }

    const results: ItemResult[] = [];
    let stop: { code: string; message: string; retryAfter: number | null } | null = null;
    try {
      for (const decision of decisions) {
        const { item, operation } = decision;
        if (stop) {
          results.push({
            key: item.key,
            action: item.action,
            outcome: operation === 'none' ? 'skipped' : 'not_attempted',
            errorCode: null,
          });
          continue;
        }
        if (operation === 'none') {
          results.push({
            key: item.key,
            action: item.action,
            outcome: item.action === 'unchanged' ? 'unchanged' : 'skipped',
            errorCode: null,
          });
          continue;
        }
        try {
          await this.apply(
            client,
            plan.project.id,
            mapping,
            item,
            operation,
            values,
            jobId,
            caller.project.scope.workspaceId,
          );
          results.push({
            key: item.key,
            action: item.action,
            outcome: operation === 'delete' || operation === 'forget' ? 'removed' : 'written',
            errorCode: null,
          });
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          results.push({
            key: item.key,
            action: item.action,
            outcome: 'failed',
            errorCode: error.code,
          });
          const blocking =
            error.code === INTEGRATION_ERROR_CODES.PROVIDER_AUTH_FAILED ||
            error.code === INTEGRATION_ERROR_CODES.PROVIDER_FORBIDDEN ||
            error.code === INTEGRATION_ERROR_CODES.PROVIDER_RATE_LIMITED ||
            error.code === INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE;
          if (blocking) {
            stop = {
              code: error.code,
              message: 'Vercel stopped the synchronisation',
              retryAfter: error.retryAfterSeconds,
            };
            if (
              error.code !== INTEGRATION_ERROR_CODES.PROVIDER_RATE_LIMITED &&
              error.code !== INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE
            ) {
              await this.integrations
                .providerError(caller, connectionId, error)
                .catch(() => undefined);
            }
          }
        }
      }
    } finally {
      values.clear();
    }

    const failed = results.filter(
      (r) => r.outcome === 'failed' || r.outcome === 'not_attempted',
    ).length;
    const done = results.filter((r) => r.outcome === 'written' || r.outcome === 'removed').length;
    const status = failed === 0 ? 'SUCCEEDED' : done > 0 ? 'PARTIAL' : 'FAILED';
    const firstError = results.find((r) => r.errorCode)?.errorCode ?? null;
    return finish(
      status,
      results,
      failed === 0
        ? null
        : {
            code: stop?.code ?? firstError ?? 'FAILED',
            message: stop?.message ?? 'Some variables were not written',
          },
      stop?.retryAfter ?? null,
    );
  }

  private write(mapping: MappingRecord, item: PlannedItem, value: string): VariableWrite {
    const base = {
      key: item.key,
      value,
      type: item.sensitive ? ('sensitive' as const) : ('encrypted' as const),
      comment: COMMENT,
    };
    if (mapping.target === 'CUSTOM')
      return { ...base, customEnvironmentIds: [mapping.customEnvironmentId ?? ''] };
    return {
      ...base,
      target: [mapping.target.toLowerCase() as 'development' | 'preview' | 'production'],
      ...(mapping.gitBranch ? { gitBranch: mapping.gitBranch } : {}),
    };
  }

  /** One provider write, retried only when repeating it is harmless (update, delete). */
  private async apply(
    client: VercelClient,
    projectId: string,
    mapping: MappingRecord,
    item: PlannedItem,
    operation: 'create' | 'update' | 'delete' | 'forget',
    values: Map<string, string>,
    jobId: string,
    workspaceId: string,
  ): Promise<void> {
    const repos = this.repos;
    if (operation === 'forget') {
      await repos.integrations.forgetManaged(mapping.id, item.key);
      return;
    }
    const attempt = async <T>(run: () => Promise<T>, repeatable: boolean): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return await run();
        } catch (error) {
          const transient =
            error instanceof ProviderError &&
            error.code === INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE;
          if (!repeatable || !transient || i >= RETRY_DELAYS_MS.length) throw error;
          await pause(RETRY_DELAYS_MS[i] ?? 1000);
        }
      }
    };
    if (operation === 'delete') {
      const id = item.providerVariableId ?? '';
      await attempt(
        () => client.remove(projectId, id, mapping.customEnvironmentId ?? undefined),
        true,
      ).catch((error: unknown) => {
        // Already gone is the outcome a removal wants.
        if (
          error instanceof ProviderError &&
          error.code === INTEGRATION_ERROR_CODES.PROVIDER_NOT_FOUND
        )
          return;
        throw error;
      });
      await repos.integrations.forgetManaged(mapping.id, item.key);
      return;
    }
    const value = item.secretId ? values.get(item.secretId) : undefined;
    if (value === undefined)
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, null);
    const write = this.write(mapping, item, value);
    const written =
      operation === 'create'
        ? // Not repeated: an unanswered create may have succeeded; the next preview shows it.
          await attempt(() => client.create(projectId, write), false)
        : await attempt(
            () =>
              client.update(projectId, item.providerVariableId ?? '', {
                key: write.key,
                value: write.value,
                type: write.type,
                comment: COMMENT,
              }),
            true,
          );
    await repos.integrations.recordManaged(workspaceId, mapping.id, {
      key: item.key,
      providerVariableId: written.id,
      providerUpdatedAt: BigInt(written.updatedAt),
      secretVersionId: item.versionId,
      jobId,
    });
  }

  present(job: SyncJobRecord): SyncJob {
    const summary = (job.summary ?? {}) as {
      counts?: Record<string, number>;
      items?: ItemResult[];
      retryAfterSeconds?: number | null;
      redeployRequired?: boolean;
    };
    return {
      id: job.id,
      mappingId: job.mappingId,
      environmentId: job.environmentId,
      status: job.status,
      trigger: job.trigger,
      startedAt: iso(job.startedAt),
      finishedAt: iso(job.finishedAt),
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      retryAfterSeconds: summary.retryAfterSeconds ?? null,
      counts: summary.counts ?? {},
      items: summary.items ?? [],
      requestedBy: job.requestedBy,
      redeployRequired: summary.redeployRequired === true,
    };
  }

  async jobs(caller: ProjectCaller, connectionId: string): Promise<SyncJobList> {
    await this.integrations.connection(caller, connectionId);
    const rows = await this.repos.integrations.listJobs(caller.project.scope, connectionId, 50);
    return { items: rows.map((r) => this.present(r)) };
  }
}
