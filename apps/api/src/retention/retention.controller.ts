import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type MaintenanceJob,
  type RetentionPolicy,
  type RetentionPolicyInput,
  retentionPolicyInputSchema,
  type RetentionPreview,
  type StartRetentionRunInput,
  startRetentionRunInputSchema,
} from '@envvault/shared';
import {
  CurrentPrincipal,
  CurrentWorkspace,
  RequireStepUp,
  RequireWorkspacePermission,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';
import { RetentionService } from './retention.service.js';
import { Idempotent } from '../idempotency/idempotency.interceptor.js';

@Controller({ path: 'workspaces/:workspaceId/retention', version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @RequireWorkspacePermission('workspace:update')
  get(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<RetentionPolicy> {
    return this.retention.get(workspace);
  }

  @Put()
  @RequireWorkspacePermission('workspace:update')
  @LimitSensitiveAction('access-change')
  update(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(retentionPolicyInputSchema)) body: RetentionPolicyInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<RetentionPolicy> {
    return this.retention.update(principal, workspace, body, requestIdOf(request));
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequireWorkspacePermission('workspace:update')
  preview(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<RetentionPreview> {
    return this.retention.preview(workspace);
  }

  @Post('runs')
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireWorkspacePermission('workspace:delete')
  @RequireStepUp()
  @LimitSensitiveAction('access-change')
  start(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(startRetentionRunInputSchema)) body: StartRetentionRunInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<MaintenanceJob> {
    return this.retention.start(principal, workspace, body.confirm, requestIdOf(request));
  }

  @Get('runs')
  @RequireWorkspacePermission('workspace:update')
  async list(
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
  ): Promise<{ items: MaintenanceJob[] }> {
    return { items: await this.retention.jobs(workspace) };
  }

  @Get('runs/:jobId')
  @RequireWorkspacePermission('workspace:update')
  async getRun(
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): Promise<MaintenanceJob> {
    const job = await this.retention.job(workspace, jobId);
    if (!job) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    return job;
  }
}
