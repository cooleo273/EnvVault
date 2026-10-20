import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isCryptoError, type SecretEncryptionContext, type SecretEnvelope } from '@envvault/crypto';
import {
  createRepositories,
  getConstraintViolation,
  type NewSecretVersion,
  Prisma,
  type Repositories,
  type SecretMetadataPatch,
  type SecretRecord,
  withTransaction,
  workspaceScopeOf,
} from '@envvault/database';
import {
  type CreatedSecret,
  type createSecretInputSchema,
  type listSecretsQuerySchema,
  type RevealedSecret,
  SECRET_ERROR_CODES,
  type SecretList,
  type SecretSummary,
  type SecretVersionInfo,
  secretValueProblem,
  STRICT_SECRET_TYPES,
  type updateSecretInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import type { ValidationExceptionBody } from '../common/filters/all-exceptions.filter.js';
import { uuidV7 } from '../common/uuid-v7.js';
import { DatabaseService } from '../database/database.service.js';
import { SecretEncryptionService } from '../encryption/secret-encryption.service.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { envelopeFromRow, versionRowFromEnvelope } from './secret-envelope.js';

type CreateInput = z.output<typeof createSecretInputSchema>;
type UpdateInput = z.output<typeof updateSecretInputSchema>;
type ListQuery = z.output<typeof listSecretsQuerySchema>;

const KEY_UNIQUE_INDEX = 'secrets_environment_key_live_key';

/* ------------------------------------------------------------------ errors */

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

function keyTaken(key: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    SECRET_ERROR_CODES.SECRET_KEY_TAKEN,
    `A variable named ${key} already exists in this environment`,
  );
}

function conflict(message: string): ApiException {
  return new ApiException(HttpStatus.CONFLICT, SECRET_ERROR_CODES.SECRET_CONFLICT, message);
}

const STALE = 'This variable was changed by someone else. Reload it and try again.';

function invalidValue(message: string): BadRequestException {
  const body: ValidationExceptionBody = {
    message: 'Validation failed',
    issues: [{ path: 'value', message }],
  };
  return new BadRequestException(body);
}

/**
 * Maps crypto failures to client safe errors. Key problems (missing,
 * unconfigured, unknown version) are a service condition; authentication
 * failures and malformed envelopes mean the stored record cannot be trusted.
 * Neither reveals which check failed.
 */
function cryptoFailure(error: unknown): ApiException {
  const code = isCryptoError(error) ? error.code : 'UNKNOWN';
  if (code === 'NOT_CONFIGURED' || code === 'KEY_CONFIGURATION' || code === 'KEY_NOT_FOUND') {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      SECRET_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
      'Encryption keys are not available, so values cannot be stored or read right now.',
    );
  }
  if (code === 'INVALID_INPUT') {
    return new ApiException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The value cannot be stored');
  }
  return new ApiException(
    HttpStatus.INTERNAL_SERVER_ERROR,
    SECRET_ERROR_CODES.SECRET_INTEGRITY_ERROR,
    'The stored value failed an integrity check and was not returned.',
  );
}

function errorLabel(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `prisma ${error.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

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
  private readonly logger = new Logger(SecretsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: SecretEncryptionService,
    private readonly authorization: SecretAuthorizationService,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
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

  async versions(ctx: SecretRequestContext, secretId: string): Promise<SecretVersionInfo[]> {
    const scope = ctx.environment.scope;
    if (!(await this.repos.secrets.get(scope, secretId))) throw notFound();
    const rows = await this.repos.secrets.listVersions(scope, secretId);
    return rows.map((row) => ({
      id: row.id,
      version: row.versionNumber,
      isCurrent: row.isCurrent,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
    }));
  }

  async create(ctx: SecretRequestContext, input: CreateInput): Promise<CreatedSecret> {
    await this.authorization.require(ctx, 'secret:write', 'secret.created');
    const scope = ctx.environment.scope;
    if (await this.repos.secrets.isKeyTaken(scope, input.key)) throw keyTaken(input.key);

    const secretId = uuidV7();
    const version =
      input.value === undefined
        ? null
        : await this.sealVersion(ctx, secretId, input.value, 'secret.created');

    return this.write(input.key, () =>
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
        await this.audit(repos, ctx, 'secret.created', secretId, {
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
      if (problem) throw invalidValue(problem);
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
        : await this.sealVersion(ctx, secretId, input.value, 'secret.value_changed');

    await this.write(key, () =>
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
          await this.audit(repos, ctx, 'secret.updated', secretId, {
            key,
            fields,
            ...(key === record.key ? {} : { renamedFrom: record.key, renamedTo: key }),
            ...(input.type !== undefined && input.type !== record.type
              ? { typeFrom: record.type, typeTo: input.type }
              : {}),
          });
        }
        if (result.versionNumber !== null) {
          await this.audit(repos, ctx, 'secret.value_changed', secretId, {
            key,
            version: result.versionNumber,
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
    await this.write(record.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        if (
          !(await repos.secrets.softDelete(scope, secretId, ctx.principal.userId, expectedRevision))
        ) {
          throw conflict(STALE);
        }
        await this.audit(repos, ctx, 'secret.deleted', secretId, {
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
    await this.write(record.key, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        if (!(await repos.secrets.restore(scope, secretId, ctx.principal.userId))) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            SECRET_ERROR_CODES.SECRET_NOT_DELETED,
            'This variable is not deleted',
          );
        }
        await this.audit(repos, ctx, 'secret.restored', secretId, { key: record.key });
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

    const stored = await this.repos.secrets.currentVersion(scope, secretId);
    if (!stored) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        SECRET_ERROR_CODES.SECRET_VALUE_NOT_SET,
        'This variable has no value yet',
      );
    }
    let value: string;
    try {
      value = await this.encryption.decryptSecret(
        envelopeFromRow(stored),
        this.context(ctx, secretId, stored.versionId),
      );
    } catch (error) {
      await this.auditFailure(ctx, 'secret.decryption_failed', secretId, error, {
        key: record.key,
        version: stored.versionNumber,
      });
      throw cryptoFailure(error);
    }
    try {
      await this.audit(this.repos, ctx, 'secret.revealed', secretId, {
        key: record.key,
        version: stored.versionNumber,
      });
    } catch (error) {
      this.logger.error(`Reveal withheld: audit write failed (${errorLabel(error)})`);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUDIT_UNAVAILABLE',
        'The value was not returned because the access could not be recorded.',
      );
    }
    return {
      id: record.id,
      key: record.key,
      type: record.type,
      version: stored.versionNumber,
      value,
    };
  }

  /* ----------------------------------------------------------------- helpers */

  private context(
    ctx: SecretRequestContext,
    secretId: string,
    secretVersionId: string,
  ): SecretEncryptionContext {
    const { workspaceId, projectId, environmentId } = ctx.environment.scope;
    // The AAD needs canonical lowercase ids; route params may arrive in upper case.
    return {
      workspaceId: workspaceId.toLowerCase(),
      projectId: projectId.toLowerCase(),
      environmentId: environmentId.toLowerCase(),
      secretId: secretId.toLowerCase(),
      secretVersionId: secretVersionId.toLowerCase(),
    };
  }

  /** Encrypts a value for a new version and resolves its key row. Writes nothing on failure. */
  private async sealVersion(
    ctx: SecretRequestContext,
    secretId: string,
    value: string,
    action: string,
  ): Promise<NewSecretVersion> {
    const versionId = uuidV7();
    let envelope: SecretEnvelope;
    try {
      envelope = await this.encryption.encryptSecret(value, this.context(ctx, secretId, versionId));
    } catch (error) {
      await this.auditFailure(ctx, 'secret.encryption_failed', secretId, error, {
        attempted: action,
      });
      throw cryptoFailure(error);
    }
    const keyRowId = await this.write(null, () => this.encryptionKeyId(ctx, envelope));
    return versionRowFromEnvelope(versionId, keyRowId, envelope);
  }

  private async encryptionKeyId(
    ctx: SecretRequestContext,
    envelope: SecretEnvelope,
  ): Promise<string> {
    const workspace = workspaceScopeOf(ctx.environment.scope);
    const found = await this.repos.encryptionKeys.find(
      workspace,
      envelope.providerId,
      envelope.keyId,
    );
    if (found) return found.id;
    const registered = await withTransaction(this.database.client, (tx) =>
      createRepositories(tx).encryptionKeys.ensureActive(
        workspace,
        envelope.providerId,
        envelope.keyId,
      ),
    );
    return registered.id;
  }

  /** Runs a write and reduces unexpected errors to a generic, value free 500. */
  private async write<T>(key: string | null, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const violation = getConstraintViolation(error);
      if (violation?.constraint === KEY_UNIQUE_INDEX && key !== null) throw keyTaken(key);
      this.logger.error(
        `Secret write failed (${errorLabel(error)}${violation?.constraint ? `, ${violation.constraint}` : ''})`,
      );
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_SERVER_ERROR',
        'The change could not be saved',
      );
    }
  }

  private async audit(
    repos: Repositories,
    ctx: SecretRequestContext,
    action: string,
    secretId: string,
    metadata: Record<string, string | number | boolean | string[]>,
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: ctx.environment.scope.workspaceId,
      projectId: ctx.environment.scope.projectId,
      environmentId: ctx.environment.scope.environmentId,
      actorUserId: ctx.principal.userId,
      action,
      outcome: 'SUCCESS',
      resourceType: 'secret',
      resourceId: secretId,
      requestId: ctx.requestId,
      metadata,
    });
  }

  /** FAILURE event with the error category only (never messages, values or key material). */
  private async auditFailure(
    ctx: SecretRequestContext,
    action: string,
    secretId: string,
    error: unknown,
    metadata: Record<string, string | number>,
  ): Promise<void> {
    try {
      await this.repos.audit.append({
        workspaceId: ctx.environment.scope.workspaceId,
        projectId: ctx.environment.scope.projectId,
        environmentId: ctx.environment.scope.environmentId,
        actorUserId: ctx.principal.userId,
        action,
        outcome: 'FAILURE',
        resourceType: 'secret',
        resourceId: secretId,
        requestId: ctx.requestId,
        metadata: { ...metadata, errorCode: isCryptoError(error) ? error.code : 'UNKNOWN' },
      });
    } catch (auditError) {
      this.logger.error(`Could not record ${action} (${errorLabel(auditError)})`);
    }
  }
}
