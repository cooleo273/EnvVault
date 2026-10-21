import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  compareEnvironmentsInputSchema,
  createSnapshotInputSchema,
  type EffectiveConfiguration,
  type EnvironmentComparison,
  listSnapshotsQuerySchema,
  type ReadinessReport,
  readinessInputSchema,
  replaceValidationRulesInputSchema,
  type RestorePreview,
  restorePreviewInputSchema,
  type RestoreResult,
  restoreSnapshotInputSchema,
  type SnapshotDetail,
  type SnapshotDiff,
  snapshotDiffInputSchema,
  type SnapshotPage,
  type SnapshotSummary,
  updateInheritanceInputSchema,
  type ValidationRule,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentEnvironment,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireEnvironmentPermission,
  RequireProjectPermission,
} from '../auth/auth.decorators.js';
import type {
  AuthenticatedRequest,
  AuthorizedEnvironment,
  AuthorizedProject,
  AuthorizedWorkspace,
  Principal,
} from '../auth/principal.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { UuidParam } from '../common/uuid-param.js';
import { ComparisonService } from './comparison.service.js';
import { ConfigurationService } from './configuration.service.js';
import type { ProjectCaller } from './environment-access.service.js';
import { ReadinessService } from './readiness.service.js';
import { SnapshotService } from './snapshot.service.js';
import { ValidationService } from './validation.service.js';
import { Idempotent } from '../idempotency/idempotency.interceptor.js';

function callerOf(
  principal: Principal,
  workspace: AuthorizedWorkspace,
  project: AuthorizedProject,
  request: AuthenticatedRequest,
): ProjectCaller {
  return { principal, membership: workspace.membership, project, requestId: requestIdOf(request) };
}

/** Comparison of two environments of a project. Each one is authorized on its own. */
@Controller({ path: 'workspaces/:workspaceId/projects/:projectId/environments', version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class EnvironmentComparisonController {
  constructor(private readonly comparison: ComparisonService) {}

  @Post('compare')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('project:read')
  @AllowArchived('workspace', 'project')
  compare(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(compareEnvironmentsInputSchema))
    body: z.output<typeof compareEnvironmentsInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<EnvironmentComparison> {
    return this.comparison.compare(callerOf(principal, workspace, project, request), body);
  }
}

/**
 * Inheritance, validation rules, readiness and snapshots of one environment.
 * Every route needs `secret:list` or `environment:update` here through the
 * guard; the services check the data plane permissions of each operation.
 */
@Controller({
  path: 'workspaces/:workspaceId/projects/:projectId/environments/:environmentId',
  version: '1',
})
@UseInterceptors(NoStoreInterceptor)
export class EnvironmentIntelligenceController {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly validation: ValidationService,
    private readonly readiness: ReadinessService,
    private readonly snapshots: SnapshotService,
  ) {}

  /** Local and inherited variables (metadata only). */
  @Get('effective')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  effective(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Req() request: AuthenticatedRequest,
  ): Promise<EffectiveConfiguration> {
    return this.configuration.effective(
      callerOf(principal, workspace, project, request),
      environment,
    );
  }

  @Put('inheritance')
  @RequireEnvironmentPermission('environment:update')
  setInheritance(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(updateInheritanceInputSchema))
    body: z.output<typeof updateInheritanceInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<EffectiveConfiguration> {
    return this.configuration.setBase(
      callerOf(principal, workspace, project, request),
      environment,
      body.baseEnvironmentId,
    );
  }

  @Get('validation-rules')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  rules(@CurrentEnvironment() environment: AuthorizedEnvironment): Promise<ValidationRule[]> {
    return this.validation.list(environment);
  }

  /** Replaces the whole rule set. */
  @Put('validation-rules')
  @RequireEnvironmentPermission('environment:update')
  replaceRules(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(replaceValidationRulesInputSchema))
    body: z.output<typeof replaceValidationRulesInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ValidationRule[]> {
    return this.validation.replace(
      callerOf(principal, workspace, project, request),
      environment,
      body,
    );
  }

  /** Configuration readiness. Values are decrypted only with `inspectValues`. */
  @Post('readiness')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  evaluate(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(readinessInputSchema)) body: z.output<typeof readinessInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReadinessReport> {
    return this.readiness.evaluate(
      callerOf(principal, workspace, project, request),
      environment,
      body,
    );
  }

  @Get('snapshots')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  listSnapshots(
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Query(new ZodValidationPipe(listSnapshotsQuerySchema))
    query: z.output<typeof listSnapshotsQuerySchema>,
  ): Promise<SnapshotPage> {
    return this.snapshots.list(environment, query);
  }

  @Post('snapshots')
  @Idempotent()
  @RequireEnvironmentPermission('secret:list')
  createSnapshot(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @Body(new ZodValidationPipe(createSnapshotInputSchema))
    body: z.output<typeof createSnapshotInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SnapshotSummary> {
    return this.snapshots.create(
      callerOf(principal, workspace, project, request),
      environment,
      body,
    );
  }

  @Get('snapshots/:snapshotId')
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  getSnapshot(
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('snapshotId') snapshotId: string,
  ): Promise<SnapshotDetail> {
    return this.snapshots.get(environment, snapshotId);
  }

  /** Drift from a snapshot to another snapshot or to the current state. */
  @Post('snapshots/:snapshotId/diff')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  @AllowArchived('workspace', 'project', 'environment')
  diff(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('snapshotId') snapshotId: string,
    @Body(new ZodValidationPipe(snapshotDiffInputSchema))
    body: z.output<typeof snapshotDiffInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SnapshotDiff> {
    return this.snapshots.diff(
      callerOf(principal, workspace, project, request),
      environment,
      snapshotId,
      body,
    );
  }

  @Post('snapshots/:snapshotId/restore/preview')
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  previewRestore(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('snapshotId') snapshotId: string,
    @Body(new ZodValidationPipe(restorePreviewInputSchema))
    body: z.output<typeof restorePreviewInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<RestorePreview> {
    return this.snapshots.preview(
      callerOf(principal, workspace, project, request),
      environment,
      snapshotId,
      body.removeAdded,
    );
  }

  @Post('snapshots/:snapshotId/restore')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @RequireEnvironmentPermission('secret:list')
  restore(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @CurrentEnvironment() environment: AuthorizedEnvironment,
    @UuidParam('snapshotId') snapshotId: string,
    @Body(new ZodValidationPipe(restoreSnapshotInputSchema))
    body: z.output<typeof restoreSnapshotInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<RestoreResult> {
    return this.snapshots.restore(
      callerOf(principal, workspace, project, request),
      environment,
      snapshotId,
      body,
    );
  }
}
