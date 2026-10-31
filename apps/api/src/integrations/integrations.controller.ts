import {
  Body,
  Controller,
  Delete,
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
  createMappingInputSchema,
  createVercelConnectionInputSchema,
  type CustomEnvironmentList,
  type IntegrationConnection,
  type IntegrationList,
  type IntegrationMapping,
  linkProviderProjectInputSchema,
  type ProviderProjectList,
  providerProjectQuerySchema,
  replaceCredentialInputSchema,
  type SyncJob,
  type SyncJobList,
  type SyncPlan,
  syncInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowArchived,
  CurrentPrincipal,
  CurrentProject,
  CurrentWorkspace,
  RequireProjectPermission,
  RequireStepUp,
} from '../auth/auth.decorators.js';
import type {
  AuthenticatedRequest,
  AuthorizedProject,
  AuthorizedWorkspace,
  Principal,
} from '../auth/principal.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { UuidParam } from '../common/uuid-param.js';
import type { ProjectCaller } from '../intelligence/environment-access.service.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { IntegrationsService } from './integrations.service.js';

function callerOf(
  principal: Principal,
  workspace: AuthorizedWorkspace,
  project: AuthorizedProject,
  request: AuthenticatedRequest,
): ProjectCaller {
  return { principal, membership: workspace.membership, project, requestId: requestIdOf(request) };
}

/**
 * Deployment integrations of a project (Vercel), managed by people only:
 * machine tokens are refused here by the authentication guard. Reading needs
 * `integration:read`; changing needs `integration:manage` and, except for
 * narrowing actions, a recent password confirmation. Synchronising also needs
 * `secret:read` and `secret:export` on the environment, checked in the service.
 */
@Controller({ path: 'workspaces/:workspaceId/projects/:projectId/integrations', version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly sync: IntegrationSyncService,
  ) {}

  @Get()
  @RequireProjectPermission('integration:read')
  @AllowArchived('workspace', 'project')
  list(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationList> {
    return this.integrations.list(callerOf(principal, workspace, project, request));
  }

  @Post('vercel')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  connect(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(createVercelConnectionInputSchema))
    body: z.output<typeof createVercelConnectionInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.connectVercel(callerOf(principal, workspace, project, request), body);
  }

  @Get(':integrationId')
  @RequireProjectPermission('integration:read')
  @AllowArchived('workspace', 'project')
  get(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.get(callerOf(principal, workspace, project, request), integrationId);
  }

  @Put(':integrationId/credential')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  replaceToken(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(replaceCredentialInputSchema))
    body: z.output<typeof replaceCredentialInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.replaceToken(
      callerOf(principal, workspace, project, request),
      integrationId,
      body.token,
    );
  }

  @Post(':integrationId/check')
  @RequireProjectPermission('integration:manage')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.check(callerOf(principal, workspace, project, request), integrationId);
  }

  @Post(':integrationId/disable')
  @RequireProjectPermission('integration:manage')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.setEnabled(
      callerOf(principal, workspace, project, request),
      integrationId,
      false,
    );
  }

  @Post(':integrationId/enable')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  enable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.setEnabled(
      callerOf(principal, workspace, project, request),
      integrationId,
      true,
    );
  }

  @Delete(':integrationId')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.integrations.disconnect(
      callerOf(principal, workspace, project, request),
      integrationId,
    );
  }

  @Get(':integrationId/vercel/projects')
  @RequireProjectPermission('integration:manage')
  projects(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Query(new ZodValidationPipe(providerProjectQuerySchema))
    query: z.output<typeof providerProjectQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProviderProjectList> {
    return this.integrations.providerProjects(
      callerOf(principal, workspace, project, request),
      integrationId,
      query.search,
    );
  }

  @Put(':integrationId/vercel/project')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  link(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(linkProviderProjectInputSchema))
    body: z.output<typeof linkProviderProjectInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationConnection> {
    return this.integrations.link(
      callerOf(principal, workspace, project, request),
      integrationId,
      body.projectId,
    );
  }

  @Get(':integrationId/vercel/custom-environments')
  @RequireProjectPermission('integration:read')
  customEnvironments(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CustomEnvironmentList> {
    return this.integrations.customEnvironments(
      callerOf(principal, workspace, project, request),
      integrationId,
    );
  }

  @Get(':integrationId/mappings')
  @RequireProjectPermission('integration:read')
  @AllowArchived('workspace', 'project')
  mappings(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: IntegrationMapping[] }> {
    return this.integrations.mappings(
      callerOf(principal, workspace, project, request),
      integrationId,
    );
  }

  @Post(':integrationId/mappings')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  createMapping(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(createMappingInputSchema))
    body: z.output<typeof createMappingInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationMapping> {
    return this.integrations.createMapping(
      callerOf(principal, workspace, project, request),
      integrationId,
      body,
    );
  }

  @Delete(':integrationId/mappings/:mappingId')
  @RequireProjectPermission('integration:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMapping(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @UuidParam('mappingId') mappingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.integrations.deleteMapping(
      callerOf(principal, workspace, project, request),
      integrationId,
      mappingId,
    );
  }

  @Post(':integrationId/mappings/:mappingId/preview')
  @RequireProjectPermission('integration:read')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @UuidParam('mappingId') mappingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyncPlan> {
    return this.sync.preview(
      callerOf(principal, workspace, project, request),
      integrationId,
      mappingId,
    );
  }

  @Post(':integrationId/mappings/:mappingId/sync')
  @RequireProjectPermission('integration:manage')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  run(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @UuidParam('mappingId') mappingId: string,
    @Body(new ZodValidationPipe(syncInputSchema)) body: z.output<typeof syncInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyncJob> {
    return this.sync.sync(
      callerOf(principal, workspace, project, request),
      integrationId,
      mappingId,
      body,
    );
  }

  @Get(':integrationId/jobs')
  @RequireProjectPermission('integration:read')
  @AllowArchived('workspace', 'project')
  jobs(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('integrationId') integrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyncJobList> {
    return this.sync.jobs(callerOf(principal, workspace, project, request), integrationId);
  }
}
