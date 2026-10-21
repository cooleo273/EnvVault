import { timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { createRepositories, type SecretVersionRecord, withTransaction } from '@envvault/database';
import {
  type CompareVersionsInput,
  type RevealedVersion,
  type RollbackInput,
  SECRET_TRANSFER_ERROR_CODES,
  type SecretSummary,
  type SecretVersionDetail,
  type SecretVersionPage,
  type secretVersionsQuerySchema,
  secretValueProblem,
  type VersionComparison,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { SecretRateLimiter } from './secret-rate-limiter.js';
import { conflict, notFound, SecretVault, STALE } from './secret-vault.service.js';
import { toSecretSummary } from './secrets.service.js';

type VersionsQuery = z.output<typeof secretVersionsQuerySchema>;

function toDetail(record: SecretVersionRecord): SecretVersionDetail {
  return {
    id: record.id,
    version: record.versionNumber,
    isCurrent: record.isCurrent,
    origin: record.origin,
    changeReason: record.changeReason,
    restoredFromVersion: record.restoredFromVersion,
    keyVersion: record.keyVersion,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
  };
}

/** Constant time equality of two UTF-8 strings (lengths are not secret here). */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  try {
    return left.length === right.length && timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}

/**
 * Version history of one variable. Listing reads metadata only; historical
 * values are decrypted for an explicit, audited reveal, for a server side
 * comparison, or to encrypt them again into a new version on rollback. Stored
 * versions are never modified.
 */
@Injectable()
export class SecretHistoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
  ) {}

  async list(
    ctx: SecretRequestContext,
    secretId: string,
    query: VersionsQuery,
  ): Promise<SecretVersionPage> {
    const scope = ctx.environment.scope;
    if (!(await this.vault.repos.secrets.get(scope, secretId))) throw notFound();
    const page = await this.vault.repos.secrets.listVersions(scope, secretId, query);
    return { items: page.items.map(toDetail), total: page.total, nextBefore: page.nextBefore };
  }

  /** One historical value, with the same checks as a current reveal. */
  async reveal(
    ctx: SecretRequestContext,
    secretId: string,
    versionId: string,
  ): Promise<RevealedVersion> {
    const record = await this.liveRecord(ctx, secretId);
    await this.authorization.require(ctx, 'secret:read', 'secret.version_revealed', secretId);
    await this.authorization.requireStepUpIfProtected(ctx, secretId, 'secret.version_revealed');
    await this.limiter.consume(ctx, 'reveal', secretId);
    const stored = await this.vault.repos.secrets.version(
      ctx.environment.scope,
      secretId,
      versionId,
    );
    if (!stored) throw notFound();
    const value = await this.vault.open(ctx, secretId, stored, { key: record.key });
    await this.vault.auditRead(ctx, 'secret.version_revealed', secretId, {
      key: record.key,
      version: stored.versionNumber,
      isCurrent: stored.versionId === record.currentVersionId,
    });
    return { secretId, versionId: stored.versionId, version: stored.versionNumber, value };
  }

  /**
   * Whether two versions hold the same value. Needs value read access (the
   * answer is derived from plaintext) but returns no value.
   */
  async compare(
    ctx: SecretRequestContext,
    secretId: string,
    input: CompareVersionsInput,
  ): Promise<VersionComparison> {
    const record = await this.liveRecord(ctx, secretId);
    await this.authorization.require(ctx, 'secret:read', 'secret.versions_compared', secretId);
    await this.authorization.requireStepUpIfProtected(ctx, secretId, 'secret.versions_compared');
    await this.limiter.consume(ctx, 'reveal', secretId);
    const scope = ctx.environment.scope;
    const [from, to] = await Promise.all([
      this.vault.repos.secrets.version(scope, secretId, input.fromVersionId),
      this.vault.repos.secrets.version(scope, secretId, input.toVersionId),
    ]);
    if (!from || !to) throw notFound();
    const details = await this.vault.repos.secrets.versionDetails(scope, secretId, [
      from.versionId,
      to.versionId,
    ]);
    const fromDetail = details.find((d) => d.id === from.versionId);
    const toRecord = details.find((d) => d.id === to.versionId);
    if (!fromDetail || !toRecord) throw notFound();
    const [left, right] = [
      await this.vault.open(ctx, secretId, from, { key: record.key }),
      await this.vault.open(ctx, secretId, to, { key: record.key }),
    ];
    const sameValue = sameText(left, right);
    await this.vault.auditRead(ctx, 'secret.versions_compared', secretId, {
      key: record.key,
      fromVersion: from.versionNumber,
      toVersion: to.versionNumber,
      sameValue,
    });
    return {
      from: toDetail(fromDetail),
      to: toDetail(toRecord),
      sameValue,
      fromBytes: Buffer.byteLength(left, 'utf8'),
      toBytes: Buffer.byteLength(right, 'utf8'),
    };
  }

  /**
   * Restores an earlier value as a NEW version: the historical value is
   * decrypted on the server, checked against the current type, encrypted again
   * under the active key and appended. The source version is untouched.
   */
  async rollback(
    ctx: SecretRequestContext,
    secretId: string,
    input: RollbackInput,
  ): Promise<SecretSummary> {
    const scope = ctx.environment.scope;
    const record = await this.vault.repos.secrets.get(scope, secretId);
    if (!record) throw notFound();
    await this.authorization.require(ctx, 'secret:rollback', 'secret.rolled_back', secretId);
    await this.limiter.consume(ctx, 'rollback', secretId);
    if (record.deletedAt) throw conflict('This variable was deleted. Restore it first.');
    if (record.revision !== input.expectedRevision) throw conflict(STALE);
    const target = await this.vault.repos.secrets.version(scope, secretId, input.versionId);
    if (!target) throw notFound();
    if (target.versionId === record.currentVersionId) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        SECRET_TRANSFER_ERROR_CODES.SECRET_ROLLBACK_NOOP,
        'That version is already the current value.',
      );
    }
    const value = await this.vault.open(ctx, secretId, target, { key: record.key });
    if (secretValueProblem(record.type, value) !== null) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        SECRET_TRANSFER_ERROR_CODES.SECRET_ROLLBACK_TYPE_MISMATCH,
        `Version ${String(target.versionNumber)} does not fit the current type. Change the type first.`,
      );
    }
    const version = await this.vault.seal(ctx, secretId, value, 'secret.rolled_back', {
      origin: 'ROLLBACK',
      changeReason: input.changeReason,
      restoredFromVersionId: target.versionId,
    });
    await this.vault.write(record.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        await this.authorization.recheck(ctx, repos, ['secret:rollback'], 'secret.rolled_back');
        const result = await repos.secrets.update(
          scope,
          secretId,
          input.expectedRevision,
          {},
          version,
          ctx.principal.userId,
        );
        if (!result) throw conflict(STALE);
        await this.vault.audit(repos, ctx, 'secret.rolled_back', secretId, {
          key: record.key,
          restoredVersion: target.versionNumber,
          previousVersion: record.currentVersionNumber,
          version: result.versionNumber,
          keyVersion: Number(version.kmsKeyVersion),
          hasReason: Boolean(input.changeReason),
        });
      }),
    );
    const updated = await this.vault.repos.secrets.get(scope, secretId);
    if (!updated) throw notFound();
    return toSecretSummary(updated);
  }

  private async liveRecord(ctx: SecretRequestContext, secretId: string) {
    const record = await this.vault.repos.secrets.get(ctx.environment.scope, secretId);
    if (!record || record.deletedAt) throw notFound();
    return record;
  }
}
