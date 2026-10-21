import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  compareVersionsInputSchema,
  type RevealedVersion,
  rollbackInputSchema,
  type SecretVersionPage,
  secretVersionsQuerySchema,
  type VersionComparison,
  type CreatedSecret,
  createSecretInputSchema,
  deleteSecretQuerySchema,
  listSecretsQuerySchema,
  type RevealedSecret,
  type SecretList,
  type SecretSummary,
  updateSecretInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentEnvironment,
  CurrentPrincipal,
  RequireEnvironmentPermission,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedEnvironment, Principal } from '../auth/principal.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { UuidParam } from '../common/uuid-param.js';
import type { SecretRequestContext } from './secret-authorization.service.js';
import { SecretHistoryService } from './secret-history.service.js';
import { SECRETS_ROUTE } from './secret-transfers.controller.js';
import { SecretsService } from './secrets.service.js';
import { Idempotent } from '../idempotency/idempotency.interceptor.js';

function contextOf(
  principal: Principal,
  environment: AuthorizedEnvironment,
  request: AuthenticatedRequest,
): SecretRequestContext {
  return { principal, environment, requestId: requestIdOf(request) };
}

/**
 * Environment variables. Every route needs `secret:list` in the environment
 * (enforced by the global guard, which also proves the workspace, project and
 * environment chain); data plane permissions are checked per operation by
 * SecretsService. Responses are never cacheable. Archived environments are
 * readable, not writable.
 */
@Controller({ path: SECRETS_ROUTE, version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class SecretsController {
  constructor(
    private readonly secrets: SecretsService,
    private readonly history: SecretHistoryService,
  ) {}

  /** Metadata only: never decrypts. */
  @Get()
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  list(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Query(new ZodValidationPipe(listSecretsQuerySchema))
    query: z.output<typeof listSecretsQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretList> {
    return this.secrets.list(contextOf(principal, environment, request), query);
  }

  @Post()
  @Idempotent()
  @RequireEnvironmentPermission('secret:list')
  create(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(createSecretInputSchema))
    body: z.output<typeof createSecretInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreatedSecret> {
    return this.secrets.create(contextOf(principal, environment, request), body);
  }

  @Get(':secretId')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  get(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretSummary> {
    return this.secrets.get(contextOf(principal, environment, request), secretId);
  }

  /** Version history, newest first: metadata only, never values. */
  @Get(':secretId/versions')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  versions(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Query(new ZodValidationPipe(secretVersionsQuerySchema))
    query: z.output<typeof secretVersionsQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretVersionPage> {
    return this.history.list(contextOf(principal, environment, request), secretId, query);
  }

  /** Decrypts one historical value (audited, rate limited). */
  @Post(':secretId/versions/:versionId/reveal')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  revealVersion(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @UuidParam('versionId') versionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RevealedVersion> {
    return this.history.reveal(contextOf(principal, environment, request), secretId, versionId);
  }

  /** Whether two versions hold the same value; returns no values. */
  @Post(':secretId/versions/compare')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  compare(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Body(new ZodValidationPipe(compareVersionsInputSchema))
    body: z.output<typeof compareVersionsInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<VersionComparison> {
    return this.history.compare(contextOf(principal, environment, request), secretId, body);
  }

  /** Restores an earlier value as a new version. */
  @Post(':secretId/rollback')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  rollback(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Body(new ZodValidationPipe(rollbackInputSchema)) body: z.output<typeof rollbackInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretSummary> {
    return this.history.rollback(contextOf(principal, environment, request), secretId, body);
  }

  @Patch(':secretId')
  @Idempotent()
  @RequireEnvironmentPermission('secret:list')
  update(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Body(new ZodValidationPipe(updateSecretInputSchema))
    body: z.output<typeof updateSecretInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretSummary> {
    return this.secrets.update(contextOf(principal, environment, request), secretId, body);
  }

  /** Soft delete; restorable. */
  @Delete(':secretId')
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireEnvironmentPermission('secret:list')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Query(new ZodValidationPipe(deleteSecretQuerySchema))
    query: z.output<typeof deleteSecretQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.secrets.remove(
      contextOf(principal, environment, request),
      secretId,
      query.expectedRevision,
    );
  }

  @Post(':secretId/restore')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  restore(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretSummary> {
    return this.secrets.restore(contextOf(principal, environment, request), secretId);
  }

  /** Decrypts one current value for an authorized caller and audits it. */
  @Post(':secretId/reveal')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  reveal(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RevealedSecret> {
    return this.secrets.reveal(contextOf(principal, environment, request), secretId);
  }
}
