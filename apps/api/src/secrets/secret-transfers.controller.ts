import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  bulkActionInputSchema,
  type BulkResult,
  exportInputSchema,
  type ExportResult,
  importCommitInputSchema,
  type ImportPreview,
  importPreviewInputSchema,
  type ImportResult,
  listSecretsQuerySchema,
  type SecretSelection,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentEnvironment,
  CurrentPrincipal,
  RequireEnvironmentPermission,
  AllowCliToken,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedEnvironment, Principal } from '../auth/principal.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { SecretBulkService } from './secret-bulk.service.js';
import { SecretExportService } from './secret-export.service.js';
import { SecretImportService } from './secret-import.service.js';
import { Idempotent } from '../idempotency/idempotency.interceptor.js';

/** Route prefix shared with the larger JSON body limit in app.setup.ts. */
export const SECRETS_ROUTE =
  'workspaces/:workspaceId/projects/:projectId/environments/:environmentId/secrets';

function contextOf(
  principal: Principal,
  environment: AuthorizedEnvironment,
  request: AuthenticatedRequest,
) {
  return { principal, environment, requestId: requestIdOf(request) };
}

/**
 * Operations on many variables at once: import, export, selection and bulk
 * changes. Registered before SecretsController so these fixed paths are
 * matched before `:secretId`. Like every secret route, they need
 * `secret:list` here; the data plane permissions are checked per operation.
 */
@Controller({ path: SECRETS_ROUTE, version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class SecretTransfersController {
  constructor(
    private readonly imports: SecretImportService,
    private readonly exports: SecretExportService,
    private readonly bulk: SecretBulkService,
  ) {}

  /** Parses .env content and reports what an import would do. Returns no values. */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(importPreviewInputSchema))
    body: z.output<typeof importPreviewInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ImportPreview> {
    return this.imports.preview(contextOf(principal, environment, request), body);
  }

  /** Imports the selected entries in one transaction. */
  @Post('import')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  commit(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(importCommitInputSchema))
    body: z.output<typeof importCommitInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ImportResult> {
    return this.imports.commit(contextOf(principal, environment, request), body);
  }

  /** Decrypted file content for download; POST so values never go through a URL. */
  @Post('export')
  @AllowCliToken()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  export(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(exportInputSchema)) body: z.output<typeof exportInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ExportResult> {
    return this.exports.export(contextOf(principal, environment, request), body);
  }

  @Get('selection')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  selection(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Query(new ZodValidationPipe(listSecretsQuerySchema))
    query: z.output<typeof listSecretsQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SecretSelection> {
    return this.bulk.selection(contextOf(principal, environment, request), query);
  }

  @Post('bulk')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  apply(
    @CurrentPrincipal() principal: Principal,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(bulkActionInputSchema))
    body: z.output<typeof bulkActionInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<BulkResult> {
    return this.bulk.apply(contextOf(principal, environment, request), body);
  }
}
