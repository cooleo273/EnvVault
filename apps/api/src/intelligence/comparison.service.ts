import { Injectable } from '@nestjs/common';
import type { VariableRow } from '@envvault/database';
import {
  type ComparisonRow,
  type compareEnvironmentsInputSchema,
  type EnvironmentComparison,
  type EnvironmentRef,
  INTELLIGENCE_LIMITS,
  type ValueComparison,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { SecretAuthorizationService } from '../secrets/secret-authorization.service.js';
import { SecretRateLimiter } from '../secrets/secret-rate-limiter.js';
import { notFound, SecretVault } from '../secrets/secret-vault.service.js';
import { tooLarge } from './configuration.service.js';
import { EnvironmentAccessService, type ProjectCaller } from './environment-access.service.js';
import { metaDifferences, metaFromRow, sameValue } from './variable-meta.js';

type CompareInput = z.output<typeof compareEnvironmentsInputSchema>;

/**
 * Compares the local variables of two environments of one project by name.
 * Metadata only by default: no value is decrypted and nothing derived from a
 * value is returned. With `compareValues` (needs `secret:read` in both, a
 * step up for protected ones, and the bulk read rate limit), values are
 * decrypted on the server and compared in constant time; only
 * equal/different leaves the server. No hashes or fingerprints are used.
 */
@Injectable()
export class ComparisonService {
  constructor(
    private readonly vault: SecretVault,
    private readonly access: EnvironmentAccessService,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
  ) {}

  async compare(caller: ProjectCaller, input: CompareInput): Promise<EnvironmentComparison> {
    const [source, target] = await Promise.all([
      this.access.environment(caller, input.sourceEnvironmentId),
      this.access.environment(caller, input.targetEnvironmentId),
    ]);
    // Either side not visible: refuse the whole comparison, like a missing one.
    if (!source || !target) throw notFound();
    const contexts = [source, target].map((env) => this.access.context(caller, env));
    for (const ctx of contexts) {
      await this.authorization.require(ctx, 'secret:list', 'environment.compared');
    }
    if (input.compareValues) {
      for (const ctx of contexts) {
        await this.authorization.require(ctx, 'secret:read', 'environment.values_compared');
        await this.authorization.requireStepUpIfProtected(ctx, null, 'environment.values_compared');
      }
      const [first] = contexts;
      if (first) await this.limiter.consume(first, 'bulk-read');
    }

    const repos = this.vault.repos;
    const [sourceRows, targetRows, sourceRef, targetRef] = await Promise.all([
      repos.secretBulk.variables(source.scope, INTELLIGENCE_LIMITS.variables),
      repos.secretBulk.variables(target.scope, INTELLIGENCE_LIMITS.variables),
      this.ref(caller, source),
      this.ref(caller, target),
    ]);
    if (
      sourceRows.length > INTELLIGENCE_LIMITS.variables ||
      targetRows.length > INTELLIGENCE_LIMITS.variables
    ) {
      throw tooLarge();
    }

    const bySource = new Map(sourceRows.map((r) => [r.key, r]));
    const byTarget = new Map(targetRows.map((r) => [r.key, r]));
    const keys = [...new Set([...bySource.keys(), ...byTarget.keys()])].sort();
    const values = input.compareValues
      ? await this.compareValues(
          source,
          target,
          sourceRows.filter((r) => byTarget.has(r.key)),
          byTarget,
          caller,
        )
      : new Map<string, ValueComparison>();

    const rows: ComparisonRow[] = keys.map((key) => {
      const s = bySource.get(key);
      const t = byTarget.get(key);
      const sourceMeta = s ? metaFromRow(s) : null;
      const targetMeta = t ? metaFromRow(t) : null;
      return {
        key,
        status: s && t ? 'both' : s ? 'only_source' : 'only_target',
        source: sourceMeta,
        target: targetMeta,
        differences: sourceMeta && targetMeta ? metaDifferences(sourceMeta, targetMeta) : [],
        value: values.get(key) ?? 'not_checked',
      };
    });

    const both = rows.filter((r) => r.status === 'both');
    const summary = {
      both: both.length,
      onlySource: rows.filter((r) => r.status === 'only_source').length,
      onlyTarget: rows.filter((r) => r.status === 'only_target').length,
      typeMismatch: both.filter((r) => r.differences.includes('type')).length,
      requiredMismatch: both.filter((r) => r.differences.includes('isRequired')).length,
      metadataMismatch: both.filter((r) => r.differences.length > 0).length,
      valuesEqual: rows.filter((r) => r.value === 'equal').length,
      valuesDifferent: rows.filter((r) => r.value === 'different').length,
    };

    const q = input.q?.toLowerCase();
    const filtered = rows.filter((row) => {
      if (q && !row.key.toLowerCase().includes(q)) return false;
      switch (input.filter) {
        case 'differences':
          return row.status !== 'both' || row.differences.length > 0 || row.value === 'different';
        case 'metadata':
          return row.differences.length > 0;
        case 'all':
          return true;
        default:
          return row.status === input.filter;
      }
    });
    const start = (input.page - 1) * input.pageSize;
    return {
      source: sourceRef,
      target: targetRef,
      valuesCompared: input.compareValues,
      summary,
      items: filtered.slice(start, start + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      total: filtered.length,
    };
  }

  private async compareValues(
    source: AuthorizedEnvironment,
    target: AuthorizedEnvironment,
    shared: VariableRow[],
    byTarget: Map<string, VariableRow>,
    caller: ProjectCaller,
  ): Promise<Map<string, ValueComparison>> {
    const repos = this.vault.repos;
    const withValue = shared.filter(
      (r) => r.currentVersionId && byTarget.get(r.key)?.currentVersionId,
    );
    const [sourceStored, targetStored] = await Promise.all([
      repos.secretBulk.currentVersions(
        source.scope,
        withValue.map((r) => r.id),
      ),
      repos.secretBulk.currentVersions(
        target.scope,
        withValue.flatMap((r) => {
          const t = byTarget.get(r.key);
          return t ? [t.id] : [];
        }),
      ),
    ]);
    const result = new Map<string, ValueComparison>();
    const sourceCtx = this.access.context(caller, source);
    const targetCtx = this.access.context(caller, target);
    for (const row of shared) {
      const other = byTarget.get(row.key);
      const a = sourceStored.get(row.id);
      const b = other ? targetStored.get(other.id) : undefined;
      if (!a || !b || !other) {
        result.set(row.key, 'not_comparable');
        continue;
      }
      const [left, right] = [
        await this.vault.open(sourceCtx, row.id, a, {
          key: row.key,
          attempted: 'environment.values_compared',
        }),
        await this.vault.open(targetCtx, other.id, b, {
          key: other.key,
          attempted: 'environment.values_compared',
        }),
      ];
      result.set(row.key, sameValue(left, right) ? 'equal' : 'different');
    }
    await this.vault.auditRead(
      sourceCtx,
      'environment.values_compared',
      source.scope.environmentId,
      {
        targetEnvironmentId: target.scope.environmentId,
        compared: result.size,
      },
      'environment',
    );
    return result;
  }

  private async ref(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
  ): Promise<EnvironmentRef> {
    const row = await this.vault.repos.environments.inProject(
      caller.project.scope,
      environment.scope.environmentId,
    );
    if (!row) throw notFound();
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isProtected: row.isProtected,
      status: row.status,
    };
  }
}
