import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createRepositories,
  type NewSecretVersion,
  Prisma,
  type SecretMetadataPatch,
  type SnapshotEntryData,
  type SnapshotRecord,
  type VariableRow,
  withTransaction,
} from '@envvault/database';
import {
  type createSnapshotInputSchema,
  type DiffRow,
  INTELLIGENCE_ERROR_CODES,
  INTELLIGENCE_LIMITS,
  type listSnapshotsQuerySchema,
  type MetaField,
  type RestorePreview,
  type RestoreResult,
  type restoreSnapshotInputSchema,
  type SnapshotDetail,
  type SnapshotDiff,
  type snapshotDiffInputSchema,
  type SnapshotPage,
  type SnapshotSummary,
  type ValueComparison,
  type VariableMeta,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { uuidV7 } from '../common/uuid-v7.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from '../secrets/secret-authorization.service.js';
import { SecretRateLimiter } from '../secrets/secret-rate-limiter.js';
import { conflict, notFound, SecretVault, STALE } from '../secrets/secret-vault.service.js';
import { tooLarge } from './configuration.service.js';
import type { ProjectCaller } from './environment-access.service.js';
import { metaDifferences, metaFromEntry, metaFromRow, sameValue } from './variable-meta.js';

type CreateInput = z.output<typeof createSnapshotInputSchema>;
type ListQuery = z.output<typeof listSnapshotsQuerySchema>;
type DiffInput = z.output<typeof snapshotDiffInputSchema>;
type RestoreInput = z.output<typeof restoreSnapshotInputSchema>;

/** Field changes between two metadata records, including a rename. */
function changedFields(from: VariableMeta, to: VariableMeta): (MetaField | 'key')[] {
  const fields: (MetaField | 'key')[] = metaDifferences(from, to).filter((f) => f !== 'hasValue');
  if (from.key !== to.key) fields.unshift('key');
  return fields;
}

function toSummary(record: SnapshotRecord): SnapshotSummary {
  return {
    id: record.id,
    environmentId: record.environmentId,
    description: record.description,
    status: record.status,
    schemaVersion: record.schemaVersion,
    entryCount: record.entryCount,
    baseEnvironmentId: record.baseEnvironmentId,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
  };
}

function entryFromRow(row: VariableRow): SnapshotEntryData {
  return {
    secretId: row.id,
    secretVersionId: row.currentVersionId,
    versionNumber: row.currentVersionNumber,
    key: row.key,
    type: row.type,
    category: row.category,
    tags: row.tags,
    isRequired: row.isRequired,
    inheritable: row.inheritable,
    description: row.description,
  };
}

interface PlanItem {
  entry: SnapshotEntryData;
  row: VariableRow;
  action: 'unchanged' | 'update' | 'undelete';
  fields: (MetaField | 'key')[];
  restoresValue: boolean;
}

interface Plan {
  items: PlanItem[];
  deletes: VariableRow[];
  conflicts: { key: string; reason: string }[];
  warnings: { key: string; reason: string }[];
  expectedState: { id: string; revision: number }[];
}

/**
 * Environment snapshots: immutable records of which variables existed with
 * which exact version and metadata. They never contain values, ciphertext or
 * hashes. Restoring creates NEW versions from the referenced ones (decrypted
 * and encrypted again under the active key on the server), restores metadata
 * and deletion state, and never modifies history.
 *
 * Permissions: reading needs `secret:list`; creating needs `secret:write`;
 * restoring needs `secret:write` and `secret:rollback`, plus `secret:delete`
 * when it deletes or undeletes variables, and a step up in protected
 * environments (where all of these come only from direct grants).
 */
@Injectable()
export class SnapshotService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  private ctx(caller: ProjectCaller, environment: AuthorizedEnvironment): SecretRequestContext {
    return { principal: caller.principal, environment, requestId: caller.requestId };
  }

  /** Captures the live variables in one repeatable read transaction (a consistent view). */
  async create(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    input: CreateInput,
  ): Promise<SnapshotSummary> {
    const ctx = this.ctx(caller, environment);
    await this.authorization.require(ctx, 'secret:write', 'environment.snapshot_created');
    const record = await this.vault.write(null, () =>
      withTransaction(
        this.database.client,
        async (tx) => {
          const repos = createRepositories(tx);
          const rows = await repos.secretBulk.variables(
            environment.scope,
            INTELLIGENCE_LIMITS.variables,
          );
          if (rows.length > INTELLIGENCE_LIMITS.variables) throw tooLarge();
          const detail = await repos.environments.getDetail(environment.scope);
          const created = await repos.snapshots.captureLive(
            environment.scope,
            {
              id: uuidV7(),
              description: input.description?.trim() ? input.description.trim() : null,
              baseEnvironmentId: detail?.baseEnvironmentId ?? null,
              expected: rows.length,
            },
            caller.principal.userId,
          );
          await this.vault.audit(
            repos,
            ctx,
            'environment.snapshot_created',
            created.id,
            {
              entries: rows.length,
            },
            { resourceType: 'environment_snapshot' },
          );
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeoutMs: 30_000 },
      ),
    );
    return toSummary(record);
  }

  async list(environment: AuthorizedEnvironment, query: ListQuery): Promise<SnapshotPage> {
    const { items, total } = await this.vault.repos.snapshots.list(environment.scope, {
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return { items: items.map(toSummary), page: query.page, pageSize: query.pageSize, total };
  }

  async get(environment: AuthorizedEnvironment, snapshotId: string): Promise<SnapshotDetail> {
    const record = await this.vault.repos.snapshots.get(environment.scope, snapshotId);
    if (!record) throw notFound();
    const entries = await this.vault.repos.snapshots.entries(environment.scope, snapshotId);
    return { ...toSummary(record), entries: entries.map(metaFromEntry) };
  }

  /**
   * Drift: what changed from a snapshot to another snapshot or to the
   * current state, matched by variable identity (so a rename is a change,
   * not a removal and an addition). A different version reference is
   * reported as such; it does not prove the value differs. Values are
   * compared only on request, with `secret:read` and a step up when protected.
   */
  async diff(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    snapshotId: string,
    input: DiffInput,
  ): Promise<SnapshotDiff> {
    const ctx = this.ctx(caller, environment);
    const repos = this.vault.repos;
    if (!(await repos.snapshots.get(environment.scope, snapshotId))) throw notFound();
    if (
      input.againstSnapshotId &&
      !(await repos.snapshots.get(environment.scope, input.againstSnapshotId))
    ) {
      throw notFound();
    }
    if (input.compareValues) {
      await this.authorization.require(
        ctx,
        'secret:read',
        'environment.snapshot_values_compared',
        snapshotId,
      );
      await this.authorization.requireStepUpIfProtected(
        ctx,
        snapshotId,
        'environment.snapshot_values_compared',
      );
      await this.limiter.consume(ctx, 'bulk-read');
    }
    const fromEntries = await repos.snapshots.entries(environment.scope, snapshotId);
    let toEntries: SnapshotEntryData[];
    if (input.againstSnapshotId) {
      toEntries = await repos.snapshots.entries(environment.scope, input.againstSnapshotId);
    } else {
      const rows = await repos.secretBulk.variables(
        environment.scope,
        INTELLIGENCE_LIMITS.variables,
      );
      if (rows.length > INTELLIGENCE_LIMITS.variables) throw tooLarge();
      toEntries = rows.map(entryFromRow);
    }
    const toById = new Map(toEntries.map((e) => [e.secretId, e]));
    const fromIds = new Set(fromEntries.map((e) => e.secretId));
    const items: DiffRow[] = [];
    for (const from of fromEntries) {
      const to = toById.get(from.secretId);
      if (!to) {
        items.push({
          key: from.key,
          change: 'removed',
          fields: [],
          versionChanged: false,
          value: 'not_checked',
          from: metaFromEntry(from),
          to: null,
        });
        continue;
      }
      const fields = changedFields(metaFromEntry(from), metaFromEntry(to));
      const versionChanged = from.secretVersionId !== to.secretVersionId;
      let value: ValueComparison = 'not_checked';
      if (input.compareValues) {
        if (!versionChanged) value = from.secretVersionId === null ? 'not_comparable' : 'equal';
        else value = await this.compareVersions(ctx, from, to);
      }
      items.push({
        key: to.key,
        change: fields.length > 0 || versionChanged ? 'modified' : 'unchanged',
        fields,
        versionChanged,
        value,
        from: metaFromEntry(from),
        to: metaFromEntry(to),
      });
    }
    for (const to of toEntries) {
      if (!fromIds.has(to.secretId)) {
        items.push({
          key: to.key,
          change: 'added',
          fields: [],
          versionChanged: false,
          value: 'not_checked',
          from: null,
          to: metaFromEntry(to),
        });
      }
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    if (input.compareValues) {
      await this.vault.auditRead(
        ctx,
        'environment.snapshot_values_compared',
        snapshotId,
        {
          against: input.againstSnapshotId ?? 'current',
        },
        'environment_snapshot',
      );
    }
    return {
      fromSnapshotId: snapshotId,
      toSnapshotId: input.againstSnapshotId ?? null,
      valuesCompared: input.compareValues,
      summary: {
        added: items.filter((i) => i.change === 'added').length,
        removed: items.filter((i) => i.change === 'removed').length,
        modified: items.filter((i) => i.change === 'modified').length,
        unchanged: items.filter((i) => i.change === 'unchanged').length,
        versionChanged: items.filter((i) => i.versionChanged).length,
      },
      items,
    };
  }

  async preview(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    snapshotId: string,
    removeAdded: boolean,
  ): Promise<RestorePreview> {
    await this.requireRestore(this.ctx(caller, environment), snapshotId, false);
    const plan = await this.plan(environment, snapshotId, removeAdded);
    return this.toPreview(snapshotId, plan, environment);
  }

  /**
   * Restores a snapshot atomically. Every referenced version is decrypted
   * (and encrypted again) before the transaction, so missing keys or a
   * tampered version abort the restore before anything changes. The
   * environment must still be exactly as previewed (`expectedState`).
   */
  async restore(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    snapshotId: string,
    input: RestoreInput,
  ): Promise<RestoreResult> {
    const ctx = this.ctx(caller, environment);
    await this.requireRestore(ctx, snapshotId, false);
    const plan = await this.plan(environment, snapshotId, input.removeAdded);
    const deletesOrUndeletes =
      plan.deletes.length > 0 || plan.items.some((i) => i.action === 'undelete');
    if (deletesOrUndeletes) {
      await this.authorization.require(
        ctx,
        'secret:delete',
        'environment.snapshot_restored',
        snapshotId,
      );
    }
    if (environment.isProtected) {
      await this.authorization.requireStepUpIfProtected(
        ctx,
        snapshotId,
        'environment.snapshot_restored',
      );
    }
    await this.limiter.consume(ctx, 'restore', environment.scope.environmentId);
    const expected = new Map(input.expectedState.map((s) => [s.id, s.revision]));
    if (
      expected.size !== plan.expectedState.length ||
      plan.expectedState.some((s) => expected.get(s.id) !== s.revision)
    ) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        INTELLIGENCE_ERROR_CODES.SNAPSHOT_STALE,
        'The environment changed since the preview. Preview again.',
      );
    }
    if (plan.conflicts.length > 0) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        INTELLIGENCE_ERROR_CODES.SNAPSHOT_RESTORE_BLOCKED,
        'The snapshot cannot be restored as is. See the conflicts in the preview.',
        {},
        plan.conflicts.map((c) => ({ path: c.key, message: c.reason })),
      );
    }
    const changing = plan.items.filter((i) => i.action !== 'unchanged');
    if (changing.length + plan.deletes.length > this.env.SECRET_BULK_MAX_ITEMS) throw tooLarge();

    await this.vault.write(null, () =>
      this.vault.audit(
        this.vault.repos,
        ctx,
        'environment.snapshot_restore_started',
        snapshotId,
        {
          changes: changing.length + plan.deletes.length,
        },
        { resourceType: 'environment_snapshot' },
      ),
    );
    try {
      // Decrypt and encrypt every restored value first: nothing is written if a key is missing.
      const versions = new Map<string, NewSecretVersion>();
      const keyRows = new Map<string, string>();
      for (const item of changing) {
        if (!item.restoresValue || !item.entry.secretVersionId) continue;
        const stored = await this.vault.repos.secrets.version(
          environment.scope,
          item.row.id,
          item.entry.secretVersionId,
          { includeDeleted: true },
        );
        if (!stored) throw notFound();
        const value = await this.vault.open(ctx, item.row.id, stored, {
          key: item.entry.key,
          attempted: 'environment.snapshot_restored',
        });
        versions.set(
          item.row.id,
          await this.vault.seal(
            ctx,
            item.row.id,
            value,
            'environment.snapshot_restored',
            {
              origin: 'RESTORE',
              changeReason: input.changeReason,
              restoredFromVersionId: stored.versionId,
            },
            keyRows,
          ),
        );
      }
      const result = await this.vault.write(null, () =>
        withTransaction(
          this.database.client,
          async (tx) => {
            const repos = createRepositories(tx);
            await this.authorization.recheck(
              ctx,
              repos,
              deletesOrUndeletes
                ? ['secret:write', 'secret:rollback', 'secret:delete']
                : ['secret:write', 'secret:rollback'],
              'environment.snapshot_restored',
            );
            const user = caller.principal.userId;
            if (plan.deletes.length > 0) {
              const deleted = await repos.secretBulk.softDelete(
                environment.scope,
                plan.deletes.map((r) => ({ id: r.id, expectedRevision: r.revision })),
                user,
              );
              if (deleted.length !== plan.deletes.length) throw conflict(STALE);
            }
            const undeletes = changing.filter((i) => i.action === 'undelete');
            if (undeletes.length > 0) {
              const restored = await repos.secretBulk.restore(
                environment.scope,
                undeletes.map((i) => ({ id: i.row.id, expectedRevision: i.row.revision })),
                user,
              );
              if (restored.length !== undeletes.length) throw conflict(STALE);
            }
            for (const item of changing) {
              const version = versions.get(item.row.id) ?? null;
              if (item.fields.length === 0 && !version) continue;
              const patch: SecretMetadataPatch = {
                key: item.entry.key,
                type: item.entry.type,
                category: item.entry.category,
                tags: item.entry.tags,
                description: item.entry.description,
                isRequired: item.entry.isRequired,
                inheritable: item.entry.inheritable,
              };
              const revision =
                item.action === 'undelete' ? item.row.revision + 1 : item.row.revision;
              if (
                !(await repos.secrets.update(
                  environment.scope,
                  item.row.id,
                  revision,
                  patch,
                  version,
                  user,
                ))
              ) {
                throw conflict(STALE);
              }
            }
            const ids = [...changing.map((i) => i.row.id), ...plan.deletes.map((r) => r.id)];
            const counts = {
              updated: changing.filter((i) => i.action === 'update').length,
              undeleted: changing.filter((i) => i.action === 'undelete').length,
              deleted: plan.deletes.length,
              valueRestores: versions.size,
            };
            await this.vault.auditBatch(
              repos,
              ctx,
              'environment.snapshot_restored',
              ids,
              { snapshotId, ...counts },
              { resourceType: 'environment' },
            );
            return counts;
          },
          { timeoutMs: 60_000 },
        ),
      );
      return { snapshotId, ...result };
    } catch (error) {
      await this.vault.auditFailure(
        ctx,
        'environment.snapshot_restore_failed',
        snapshotId,
        error,
        {},
        'environment_snapshot',
      );
      throw error;
    }
  }

  /* ----------------------------------------------------------------- helpers */

  private async requireRestore(
    ctx: SecretRequestContext,
    snapshotId: string,
    deletes: boolean,
  ): Promise<void> {
    await this.authorization.require(
      ctx,
      'secret:write',
      'environment.snapshot_restored',
      snapshotId,
    );
    await this.authorization.require(
      ctx,
      'secret:rollback',
      'environment.snapshot_restored',
      snapshotId,
    );
    if (deletes)
      await this.authorization.require(
        ctx,
        'secret:delete',
        'environment.snapshot_restored',
        snapshotId,
      );
  }

  private async plan(
    environment: AuthorizedEnvironment,
    snapshotId: string,
    removeAdded: boolean,
  ): Promise<Plan> {
    const repos = this.vault.repos;
    if (!(await repos.snapshots.get(environment.scope, snapshotId))) throw notFound();
    const entries = await repos.snapshots.entries(environment.scope, snapshotId);
    const live = await repos.secretBulk.variables(environment.scope, INTELLIGENCE_LIMITS.variables);
    if (live.length > INTELLIGENCE_LIMITS.variables) throw tooLarge();
    const rows = new Map(
      (
        await repos.secretBulk.variablesByIds(
          environment.scope,
          entries.map((e) => e.secretId),
        )
      ).map((r) => [r.id, r]),
    );
    const entryIds = new Set(entries.map((e) => e.secretId));
    const deletes = removeAdded ? live.filter((r) => !entryIds.has(r.id)) : [];
    const conflicts: Plan['conflicts'] = [];
    const warnings: Plan['warnings'] = [];

    const items: PlanItem[] = [];
    for (const entry of entries) {
      const row = rows.get(entry.secretId);
      if (!row) {
        conflicts.push({ key: entry.key, reason: 'The variable no longer exists' });
        continue;
      }
      const fields = changedFields(metaFromRow(row), metaFromEntry(entry));
      let restoresValue =
        entry.secretVersionId !== null && entry.secretVersionId !== row.currentVersionId;
      if (entry.secretVersionId === null && row.currentVersionId !== null) {
        restoresValue = false;
        warnings.push({
          key: entry.key,
          reason:
            'Had no value in the snapshot; the current value is kept (values cannot be removed)',
        });
      }
      const action = row.deleted
        ? 'undelete'
        : fields.length > 0 || restoresValue
          ? 'update'
          : 'unchanged';
      items.push({ entry, row, action, fields, restoresValue });
    }

    // Names must be free: a live variable that stays and holds a restored name blocks the restore.
    const deleting = new Set(deletes.map((r) => r.id));
    const holders = new Map(live.filter((r) => !deleting.has(r.id)).map((r) => [r.key, r.id]));
    for (const item of items) {
      if (item.action === 'unchanged') continue;
      for (const key of new Set([
        item.entry.key,
        ...(item.action === 'undelete' ? [item.row.key] : []),
      ])) {
        const holder = holders.get(key);
        if (holder && holder !== item.row.id) {
          conflicts.push({
            key: item.entry.key,
            reason: `The name ${key} is used by another variable`,
          });
        }
      }
    }
    const expectedState = [
      ...live.map((r) => ({ id: r.id, revision: r.revision })),
      ...items
        .filter((i) => i.row.deleted)
        .map((i) => ({ id: i.row.id, revision: i.row.revision })),
    ].sort((a, b) => a.id.localeCompare(b.id));
    return { items, deletes, conflicts, warnings, expectedState };
  }

  private toPreview(
    snapshotId: string,
    plan: Plan,
    environment: AuthorizedEnvironment,
  ): RestorePreview {
    const actions = [
      ...plan.items.map((i) => ({
        secretId: i.row.id,
        key: i.entry.key,
        action: i.action,
        fields: i.fields,
        restoresValue: i.restoresValue,
      })),
      ...plan.deletes.map((r) => ({
        secretId: r.id,
        key: r.key,
        action: 'delete' as const,
        fields: [],
        restoresValue: false,
      })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    return {
      snapshotId,
      actions,
      conflicts: plan.conflicts,
      warnings: plan.warnings,
      expectedState: plan.expectedState,
      counts: {
        update: actions.filter((a) => a.action === 'update').length,
        undelete: actions.filter((a) => a.action === 'undelete').length,
        delete: actions.filter((a) => a.action === 'delete').length,
        unchanged: actions.filter((a) => a.action === 'unchanged').length,
        valueRestores: actions.filter((a) => a.restoresValue).length,
      },
      requiresStepUp: environment.isProtected,
    };
  }

  private async compareVersions(
    ctx: SecretRequestContext,
    from: SnapshotEntryData,
    to: SnapshotEntryData,
  ): Promise<ValueComparison> {
    if (!from.secretVersionId || !to.secretVersionId) return 'not_comparable';
    const repos = this.vault.repos;
    const [a, b] = await Promise.all([
      repos.secrets.version(ctx.environment.scope, from.secretId, from.secretVersionId, {
        includeDeleted: true,
      }),
      repos.secrets.version(ctx.environment.scope, to.secretId, to.secretVersionId, {
        includeDeleted: true,
      }),
    ]);
    if (!a || !b) return 'not_comparable';
    const left = await this.vault.open(ctx, from.secretId, a, {
      key: from.key,
      attempted: 'environment.snapshot_values_compared',
    });
    const right = await this.vault.open(ctx, to.secretId, b, {
      key: to.key,
      attempted: 'environment.snapshot_values_compared',
    });
    return sameValue(left, right) ? 'equal' : 'different';
  }
}
