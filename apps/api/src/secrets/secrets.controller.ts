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
  type CreatedSecret,
  createSecretInputSchema,
  deleteSecretQuerySchema,
  listSecretsQuerySchema,
  type RevealedSecret,
  type SecretList,
  type SecretSummary,
  type SecretVersionInfo,
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
import { SecretsService } from './secrets.service.js';

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
@Controller({
  path: 'workspaces/:workspaceId/projects/:projectId/environments/:environmentId/secrets',
  version: '1',
})
@UseInterceptors(NoStoreInterceptor)
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

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

  /** Version numbers, dates and authors. Never a previous value. */
  @Get(':secretId/versions')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  versions(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretVersionInfo[]> {
    return this.secrets.versions(contextOf(principal, environment, request), secretId);
  }

  @Patch(':secretId')
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
