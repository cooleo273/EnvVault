import { HttpStatus, Injectable } from '@nestjs/common';
import {
  createRepositories,
  type SecretMetadataPatch,
  type SecretRecord,
  withTransaction,
} from '@envvault/database';
import {
  type CreatedSecret,
  type createSecretInputSchema,
  type listSecretsQuerySchema,
  type RevealedSecret,
  SECRET_ERROR_CODES,
  type SecretList,
  type SecretSummary,
  secretValueProblem,
  STRICT_SECRET_TYPES,
  type updateSecretInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { uuidV7 } from '../common/uuid-v7.js';
import { DatabaseService } from '../database/database.service.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { SecretRateLimiter } from './secret-rate-limiter.js';
import {
  conflict,
  invalidField,
  keyTaken,
  notFound,
  SecretVault,
  STALE,
} from './secret-vault.service.js';

type CreateInput = z.output<typeof createSecretInputSchema>;
type UpdateInput = z.output<typeof updateSecretInputSchema>;
type ListQuery = z.output<typeof listSecretsQuerySchema>;

/* --------------------------------------------------------------------- DTOs */

export function toSecretSummary(record: SecretRecord): SecretSummary {
  return {
    id: record.id,
    environmentId: record.environmentId,
    key: record.key,
    description: record.description,
    type: record.type,
    category: record.category,
    tags: record.tags,
    isRequired: record.isRequired,
    status: record.deletedAt ? 'DELETED' : 'ACTIVE',
    hasValue: record.currentVersionId !== null,
    currentVersion: record.currentVersionNumber,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    deletedBy: record.deletedBy,
  };
}

/**
 * Variables of one environment: metadata CRUD, encrypted value versions and
 * audited reveals.
 *
 * Values are encrypted before any row is written (the version id is chosen
 * up front because it is bound into the ciphertext), so a failed encryption
 * leaves nothing behind, and there is no unencrypted fallback. They are
 * decrypted only in {@link reveal}, after authorization. Database errors on
 * write paths are reduced to their category before logging, because driver
 * error objects can carry bound parameters such as ciphertext.
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
  ) {}

  private get repos() {
    return this.vault.repos;
  }

  async list(ctx: SecretRequestContext, query: ListQuery): Promise<SecretList> {
    const scope = ctx.environment.scope;
    const [{ items, total }, facets] = await Promise.all([
      this.repos.secrets.list(scope, {
        status: query.status,
        q: query.q,
        types: query.type,
        categories: query.category,
        tag: query.tag,
        sort: query.sort,
        order:
          query.order ?? (query.sort === 'updated' || query.sort === 'created' ? 'desc' : 'asc'),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.repos.secrets.facets(scope),
    ]);
    return {
      items: items.map(toSecretSummary),
      page: query.page,
      pageSize: query.pageSize,
      total,
      facets,
    };
  }

  async get(ctx: SecretRequestContext, secretId: string): Promise<SecretSummary> {
    const record = await this.repos.secrets.get(ctx.environment.scope, secretId);
    if (!record) throw notFound();
    return toSecretSummary(record);
  }

  async create(ctx: SecretRequestContext, input: CreateInput): Promise<CreatedSecret> {
    await this.authorization.require(ctx, 'secret:write', 'secret.created');
    const scope = ctx.environment.scope;
    if (await this.repos.secrets.isKeyTaken(scope, input.key)) throw keyTaken(input.key);

    const secretId = uuidV7();
    const version =
      input.value === undefined
        ? null
        : await this.vault.seal(ctx, secretId, input.value, 'secret.created', { origin: 'CREATE' });

    return this.vault.write(input.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const created = await repos.secrets.create(
          scope,
          {
            id: secretId,
            key: input.key,
            description: input.description ?? null,
            type: input.type,
            category: input.category ?? null,
            tags: input.tags,
            isRequired: input.isRequired,
          },
          version,
          ctx.principal.userId,
        );
        await this.vault.audit(repos, ctx, 'secret.created', secretId, {
          key: input.key,
          type: input.type,
          hasValue: version !== null,
          ...(version ? { version: 1 } : {}),
        });
        return created;
      }),
    );
  }

  async update(
    ctx: SecretRequestContext,
    secretId: string,
    input: UpdateInput,
  ): Promise<SecretSummary> {
    const scope = ctx.environment.scope;
    const record = await this.repos.secrets.get(scope, secretId);
    if (!record) throw notFound();
    await this.authorization.require(ctx, 'secret:write', 'secret.updated', secretId);
    if (record.deletedAt) throw conflict('This variable was deleted. Restore it to edit it.');
    if (record.revision !== input.expectedRevision) throw conflict(STALE);

    const type = input.type ?? record.type;
    if (input.value !== undefined) {
      const problem = secretValueProblem(type, input.value);
      if (problem) throw invalidField('value', problem);
    } else if (
      input.type !== undefined &&
      input.type !== record.type &&
      STRICT_SECRET_TYPES.has(input.type) &&
      record.currentVersionId !== null
    ) {
      // Checking the stored value would mean decrypting it; ask for a new one instead.
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        SECRET_ERROR_CODES.SECRET_VALUE_REQUIRED,
        'Enter a value of the new type when changing to it.',
      );
    }
    const key = input.key ?? record.key;
    if (key !== record.key && (await this.repos.secrets.isKeyTaken(scope, key, secretId))) {
      throw keyTaken(key);
    }

    const patch: SecretMetadataPatch = {
      key: input.key,
      description: input.description,
      type: input.type,
      category: input.category,
      tags: input.tags,
      isRequired: input.isRequired,
    };
    const fields = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    const version =
      input.value === undefined
        ? null
        : await this.vault.seal(ctx, secretId, input.value, 'secret.value_changed', {
            origin: 'UPDATE',
            changeReason: input.changeReason,
          });

    await this.vault.write(key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const result = await repos.secrets.update(
          scope,
          secretId,
          input.expectedRevision,
          patch,
          version,
          ctx.principal.userId,
        );
        if (!result) throw conflict(STALE);
        if (fields.length > 0) {
          await this.vault.audit(repos, ctx, 'secret.updated', secretId, {
            key,
            fields,
            ...(key === record.key ? {} : { renamedFrom: record.key, renamedTo: key }),
            ...(input.type !== undefined && input.type !== record.type
              ? { typeFrom: record.type, typeTo: input.type }
              : {}),
          });
        }
        if (result.versionNumber !== null) {
          await this.vault.audit(repos, ctx, 'secret.value_changed', secretId, {
            key,
            version: result.versionNumber,
            hasReason: Boolean(input.changeReason),
          });
        }
      }),
    );
    return this.get(ctx, secretId);
  }

  async remove(
    ctx: SecretRequestContext,
    secretId: string,
    expectedRevision: number | undefined,
  ): Promise<void> {
    const scope = ctx.environment.scope;
    const record = await this.repos.secrets.get(scope, secretId);
    if (!record) throw notFound();
    await this.authorization.require(ctx, 'secret:delete', 'secret.deleted', secretId);
    if (record.deletedAt) throw conflict('This variable is already deleted.');
    await this.vault.write(record.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        if (
          !(await repos.secrets.softDelete(scope, secretId, ctx.principal.userId, expectedRevision))
        ) {
          throw conflict(STALE);
        }
        await this.vault.audit(repos, ctx, 'secret.deleted', secretId, {
          key: record.key,
          versions: record.currentVersionNumber ?? 0,
        });
      }),
    );
  }

  async restore(ctx: SecretRequestContext, secretId: string): Promise<SecretSummary> {
    const scope = ctx.environment.scope;
    const record = await this.repos.secrets.get(scope, secretId);
    if (!record) throw notFound();
    await this.authorization.require(ctx, 'secret:delete', 'secret.restored', secretId);
    if (!record.deletedAt) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        SECRET_ERROR_CODES.SECRET_NOT_DELETED,
        'This variable is not deleted',
      );
    }
    await this.vault.write(record.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        if (!(await repos.secrets.restore(scope, secretId, ctx.principal.userId))) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            SECRET_ERROR_CODES.SECRET_NOT_DELETED,
            'This variable is not deleted',
          );
        }
        await this.vault.audit(repos, ctx, 'secret.restored', secretId, { key: record.key });
      }),
    );
    return this.get(ctx, secretId);
  }

  /**
   * Decrypts exactly one current value after the permission (and, for
   * protected environments, step up) checks. The success event is written
   * before the value leaves; if it cannot be written the value is withheld.
   */
  async reveal(ctx: SecretRequestContext, secretId: string): Promise<RevealedSecret> {
    const scope = ctx.environment.scope;
    const record = await this.repos.secrets.get(scope, secretId);
    if (!record || record.deletedAt) throw notFound();
    await this.authorization.require(ctx, 'secret:read', 'secret.revealed', secretId);
    await this.authorization.requireStepUpIfProtected(ctx, secretId);

    await this.limiter.consume(ctx, 'reveal', secretId);

    const stored = await this.repos.secrets.currentVersion(scope, secretId);
    if (!stored) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        SECRET_ERROR_CODES.SECRET_VALUE_NOT_SET,
        'This variable has no value yet',
      );
    }
    const value = await this.vault.open(ctx, secretId, stored, { key: record.key });
    await this.vault.auditRead(ctx, 'secret.revealed', secretId, {
      key: record.key,
      version: stored.versionNumber,
    });
    return {
      id: record.id,
      key: record.key,
      type: record.type,
      version: stored.versionNumber,
      value,
    };
  }
}
