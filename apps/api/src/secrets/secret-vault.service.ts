import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isCryptoError, type SecretEncryptionContext, type SecretEnvelope } from '@envvault/crypto';
import {
  createRepositories,
  getConstraintViolation,
  type NewSecretVersion,
  Prisma,
  type Repositories,
  type StoredSecretVersion,
  withTransaction,
  workspaceScopeOf,
} from '@envvault/database';
import { SECRET_ERROR_CODES } from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import type { ValidationExceptionBody } from '../common/filters/all-exceptions.filter.js';
import { uuidV7 } from '../common/uuid-v7.js';

/** Secret ids per audit event; keeps metadata well under the 16 KB column limit. */
export const AUDIT_ID_CHUNK = 250;
import { DatabaseService } from '../database/database.service.js';
import { SecretEncryptionService } from '../encryption/secret-encryption.service.js';
import type { SecretRequestContext } from './secret-authorization.service.js';
import { envelopeFromRow, versionRowFromEnvelope } from './secret-envelope.js';

export const KEY_UNIQUE_INDEX = 'secrets_environment_key_live_key';

/* ------------------------------------------------------------------ errors */

export function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

export function keyTaken(key: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    SECRET_ERROR_CODES.SECRET_KEY_TAKEN,
    `A variable named ${key} already exists in this environment`,
  );
}

export function conflict(message: string): ApiException {
  return new ApiException(HttpStatus.CONFLICT, SECRET_ERROR_CODES.SECRET_CONFLICT, message);
}

export const STALE = 'This variable was changed by someone else. Reload it and try again.';

export function invalidField(path: string, message: string): BadRequestException {
  const body: ValidationExceptionBody = {
    message: 'Validation failed',
    issues: [{ path, message }],
  };
  return new BadRequestException(body);
}

/**
 * Maps crypto failures to client safe errors. Key problems (missing,
 * unconfigured, unknown version) are a service condition; authentication
 * failures and malformed envelopes mean the stored record cannot be trusted.
 * Neither reveals which check failed.
 */
export function cryptoFailure(error: unknown): ApiException {
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

export function errorLabel(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `prisma ${error.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

export function auditUnavailable(): ApiException {
  return new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    'AUDIT_UNAVAILABLE',
    'The values were not returned because the access could not be recorded.',
  );
}

export type AuditMetadata = Record<string, string | number | boolean | string[] | null>;

/** How a new version came about (stored on the version, see docs/secrets.md). */
export interface VersionProvenance {
  origin: NewSecretVersion['origin'];
  changeReason?: string | undefined;
  restoredFromVersionId?: string | undefined;
}

/**
 * The single path between secret routes and the cipher: builds encryption
 * contexts, seals values into new versions, opens stored versions, and
 * writes audit events. Every service uses it, so encryption, failure
 * auditing and error sanitising behave the same everywhere.
 */
@Injectable()
export class SecretVault {
  private readonly logger = new Logger(SecretVault.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  context(
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

  /**
   * Encrypts a value under the active key for a new version and resolves its
   * key row. Writes nothing on failure (except the failure audit event).
   * Pass the same `keyRows` map for a batch to resolve each key row once.
   */
  async seal(
    ctx: SecretRequestContext,
    secretId: string,
    value: string,
    action: string,
    provenance: VersionProvenance,
    keyRows = new Map<string, string>(),
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
    const ref = `${envelope.providerId}\u0000${envelope.keyId}`;
    let keyRowId = keyRows.get(ref);
    if (keyRowId === undefined) {
      keyRowId = await this.write(null, () => this.encryptionKeyId(ctx, envelope));
      keyRows.set(ref, keyRowId);
    }
    return {
      ...versionRowFromEnvelope(versionId, keyRowId, envelope),
      origin: provenance.origin,
      changeReason: provenance.changeReason ?? null,
      restoredFromVersionId: provenance.restoredFromVersionId ?? null,
    };
  }

  /**
   * Decrypts one stored version. A failure is audited with its error category
   * and surfaces as a client safe error; the plaintext is never logged.
   */
  async open(
    ctx: SecretRequestContext,
    secretId: string,
    stored: StoredSecretVersion,
    metadata: AuditMetadata,
  ): Promise<string> {
    try {
      return await this.encryption.decryptSecret(
        envelopeFromRow(stored),
        this.context(ctx, secretId, stored.versionId),
      );
    } catch (error) {
      await this.auditFailure(ctx, 'secret.decryption_failed', secretId, error, {
        ...metadata,
        version: stored.versionNumber,
      });
      throw cryptoFailure(error);
    }
  }

  /** Runs a write and reduces unexpected errors to a generic, value free 500. */
  async write<T>(key: string | null, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const violation = getConstraintViolation(error);
      if (violation?.constraint === KEY_UNIQUE_INDEX && key !== null) throw keyTaken(key);
      if (violation?.constraint === 'secrets_tags_count_chk') {
        throw invalidField('tags', 'A variable can have at most 20 tags');
      }
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

  async audit(
    repos: Repositories,
    ctx: SecretRequestContext,
    action: string,
    resourceId: string | null,
    metadata: AuditMetadata,
    options: { outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED'; resourceType?: string } = {},
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: ctx.environment.scope.workspaceId,
      projectId: ctx.environment.scope.projectId,
      environmentId: ctx.environment.scope.environmentId,
      actorUserId: ctx.principal.userId,
      action,
      outcome: options.outcome ?? 'SUCCESS',
      resourceType: options.resourceType ?? 'secret',
      resourceId,
      requestId: ctx.requestId,
      metadata,
    });
  }

  /**
   * Audits an operation on many secrets. The first event carries the summary
   * and up to {@link AUDIT_ID_CHUNK} ids; further ids follow in
   * `secret.batch_items` events with the same `batchId`, so every affected
   * id is recorded without exceeding the audit metadata size limit. Use the
   * transaction's repositories so the events commit with the change.
   */
  async auditBatch(
    repos: Repositories,
    ctx: SecretRequestContext,
    action: string,
    secretIds: readonly string[],
    metadata: AuditMetadata,
    options: { outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED'; resourceType?: string } = {},
  ): Promise<void> {
    const chunks: string[][] = [];
    for (let i = 0; i < secretIds.length; i += AUDIT_ID_CHUNK) {
      chunks.push(secretIds.slice(i, i + AUDIT_ID_CHUNK));
    }
    const batchId = uuidV7();
    const resourceId =
      options.resourceType === 'environment' ? ctx.environment.scope.environmentId : null;
    await this.audit(
      repos,
      ctx,
      action,
      resourceId,
      {
        ...metadata,
        batchId,
        idCount: secretIds.length,
        parts: Math.max(1, chunks.length),
        secretIds: chunks[0] ?? [],
      },
      options,
    );
    for (const [index, ids] of chunks.slice(1).entries()) {
      await this.audit(
        repos,
        ctx,
        'secret.batch_items',
        resourceId,
        {
          batchId,
          of: action,
          part: index + 2,
          secretIds: ids,
        },
        options,
      );
    }
  }

  /**
   * Records a read of plaintext before it is returned. If the event cannot
   * be written the caller must not return the value, so this throws.
   */
  async auditRead(
    ctx: SecretRequestContext,
    action: string,
    resourceId: string | null,
    metadata: AuditMetadata,
    resourceType = 'secret',
    secretIds?: readonly string[],
  ): Promise<void> {
    try {
      if (secretIds) {
        // All parts or none: a partially recorded read would understate it.
        await withTransaction(this.database.client, (tx) =>
          this.auditBatch(createRepositories(tx), ctx, action, secretIds, metadata, {
            resourceType,
          }),
        );
      } else {
        await this.audit(this.repos, ctx, action, resourceId, metadata, { resourceType });
      }
    } catch (error) {
      this.logger.error(`Read withheld: audit write failed (${errorLabel(error)})`);
      throw auditUnavailable();
    }
  }

  /** FAILURE event with the error category only (never messages, values or key material). */
  async auditFailure(
    ctx: SecretRequestContext,
    action: string,
    resourceId: string | null,
    error: unknown,
    metadata: AuditMetadata,
    resourceType = 'secret',
  ): Promise<void> {
    try {
      await this.audit(
        this.repos,
        ctx,
        action,
        resourceId,
        {
          ...metadata,
          errorCode: isCryptoError(error)
            ? error.code
            : error instanceof ApiException
              ? error.code
              : 'UNKNOWN',
        },
        { outcome: 'FAILURE', resourceType },
      );
    } catch (auditError) {
      this.logger.error(`Could not record ${action} (${errorLabel(auditError)})`);
    }
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
}
