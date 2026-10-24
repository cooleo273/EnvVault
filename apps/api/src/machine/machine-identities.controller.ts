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
  activityQuerySchema,
  createMachineGrantInputSchema,
  createMachineIdentityInputSchema,
  createServiceCredentialInputSchema,
  disableMachineIdentityInputSchema,
  type IssuedServiceCredential,
  type MachineActivityPage,
  type MachineIdentityList,
  type MachineIdentitySummary,
  machineIdentityQuerySchema,
  revokeServiceCredentialInputSchema,
  rotateServiceCredentialInputSchema,
  type ServiceCredential,
  updateMachineIdentityInputSchema,
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
import { MachineIdentitiesService } from './machine-identities.service.js';

function callerOf(
  principal: Principal,
  workspace: AuthorizedWorkspace,
  project: AuthorizedProject,
  request: AuthenticatedRequest,
): ProjectCaller {
  return { principal, membership: workspace.membership, project, requestId: requestIdOf(request) };
}

/**
 * Machine identities of a project, managed by people (never by machines:
 * machine tokens are refused on these routes by the authentication guard).
 * Responses carry no-store because issuing and rotating return a token once.
 */
@Controller({
  path: 'workspaces/:workspaceId/projects/:projectId/machine-identities',
  version: '1',
})
@UseInterceptors(NoStoreInterceptor)
export class MachineIdentitiesController {
  constructor(private readonly identities: MachineIdentitiesService) {}

  @Get()
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  list(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Query(new ZodValidationPipe(machineIdentityQuerySchema))
    query: z.output<typeof machineIdentityQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentityList> {
    return this.identities.list(callerOf(principal, workspace, project, request), query);
  }

  @Post()
  @RequireProjectPermission('service_identity:manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(createMachineIdentityInputSchema))
    body: z.output<typeof createMachineIdentityInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.create(callerOf(principal, workspace, project, request), body);
  }

  @Get(':identityId')
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  get(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.get(callerOf(principal, workspace, project, request), identityId);
  }

  @Patch(':identityId')
  @RequireProjectPermission('service_identity:manage')
  update(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Body(new ZodValidationPipe(updateMachineIdentityInputSchema))
    body: z.output<typeof updateMachineIdentityInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.update(
      callerOf(principal, workspace, project, request),
      identityId,
      body,
    );
  }

  /** Stops every credential and token of the identity at once; reversible. */
  @Post(':identityId/disable')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('service_identity:manage')
  @AllowArchived('project')
  disable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Body(new ZodValidationPipe(disableMachineIdentityInputSchema))
    body: z.output<typeof disableMachineIdentityInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.disable(
      callerOf(principal, workspace, project, request),
      identityId,
      body,
    );
  }

  @Post(':identityId/enable')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  enable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.enable(callerOf(principal, workspace, project, request), identityId);
  }

  /** Retires the identity: credentials revoked, grants removed, kept for history. */
  @Delete(':identityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('service_identity:manage')
  @AllowArchived('project')
  async retire(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.identities.retire(callerOf(principal, workspace, project, request), identityId);
  }

  /* ----------------------------------------------------------- credentials */

  @Get(':identityId/credentials')
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  credentials(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: ServiceCredential[] }> {
    return this.identities.credentials(
      callerOf(principal, workspace, project, request),
      identityId,
    );
  }

  /** Returns the token once; it is not stored and cannot be shown again. */
  @Post(':identityId/credentials')
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  issue(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Body(new ZodValidationPipe(createServiceCredentialInputSchema))
    body: z.output<typeof createServiceCredentialInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IssuedServiceCredential> {
    return this.identities.issue(
      callerOf(principal, workspace, project, request),
      identityId,
      body,
    );
  }

  @Post(':identityId/credentials/:credentialId/rotate')
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  rotate(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @UuidParam('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(rotateServiceCredentialInputSchema))
    body: z.output<typeof rotateServiceCredentialInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<IssuedServiceCredential> {
    return this.identities.rotate(
      callerOf(principal, workspace, project, request),
      identityId,
      credentialId,
      body,
    );
  }

  @Post(':identityId/credentials/:credentialId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  @AllowArchived('project')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @UuidParam('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(revokeServiceCredentialInputSchema))
    body: z.output<typeof revokeServiceCredentialInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServiceCredential> {
    return this.identities.revoke(
      callerOf(principal, workspace, project, request),
      identityId,
      credentialId,
      body,
    );
  }

  /* ---------------------------------------------------------------- grants */

  @Post(':identityId/grants')
  @RequireProjectPermission('service_identity:manage')
  grant(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Body(new ZodValidationPipe(createMachineGrantInputSchema))
    body: z.output<typeof createMachineGrantInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.grant(
      callerOf(principal, workspace, project, request),
      identityId,
      body,
    );
  }

  @Delete(':identityId/grants/:grantId')
  @RequireProjectPermission('service_identity:manage')
  @AllowArchived('project')
  removeGrant(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @UuidParam('grantId') grantId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineIdentitySummary> {
    return this.identities.removeGrant(
      callerOf(principal, workspace, project, request),
      identityId,
      grantId,
    );
  }

  @Get(':identityId/activity')
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  activity(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('identityId') identityId: string,
    @Query(new ZodValidationPipe(activityQuerySchema)) query: z.output<typeof activityQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineActivityPage> {
    return this.identities.activity(
      callerOf(principal, workspace, project, request),
      identityId,
      query,
    );
  }
}
