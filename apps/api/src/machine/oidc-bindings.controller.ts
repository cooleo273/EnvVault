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
  createOidcTrustBindingInputSchema,
  type OidcBindingAttemptList,
  type OidcTrustBinding,
  type OidcTrustBindingList,
  oidcTrustBindingQuerySchema,
  updateOidcTrustBindingInputSchema,
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
import { OidcBindingsService } from './oidc-bindings.service.js';

function callerOf(
  principal: Principal,
  workspace: AuthorizedWorkspace,
  project: AuthorizedProject,
  request: AuthenticatedRequest,
): ProjectCaller {
  return { principal, membership: workspace.membership, project, requestId: requestIdOf(request) };
}

/**
 * GitHub Actions trust bindings of a project, managed by people only (the
 * authentication guard refuses machine tokens here). Creating, changing,
 * enabling and deleting need a recent password confirmation; disabling only
 * narrows access and does not.
 */
@Controller({
  path: 'workspaces/:workspaceId/projects/:projectId/oidc-trust-bindings',
  version: '1',
})
@UseInterceptors(NoStoreInterceptor)
export class OidcBindingsController {
  constructor(private readonly bindings: OidcBindingsService) {}

  @Get()
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  list(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Query(new ZodValidationPipe(oidcTrustBindingQuerySchema))
    query: z.output<typeof oidcTrustBindingQuerySchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBindingList> {
    return this.bindings.list(callerOf(principal, workspace, project, request), query);
  }

  @Post()
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  create(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @Body(new ZodValidationPipe(createOidcTrustBindingInputSchema))
    body: z.output<typeof createOidcTrustBindingInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBinding> {
    return this.bindings.create(callerOf(principal, workspace, project, request), body);
  }

  @Get(':bindingId')
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  get(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBinding> {
    return this.bindings.get(callerOf(principal, workspace, project, request), bindingId);
  }

  @Patch(':bindingId')
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  update(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Body(new ZodValidationPipe(updateOidcTrustBindingInputSchema))
    body: z.output<typeof updateOidcTrustBindingInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBinding> {
    return this.bindings.update(callerOf(principal, workspace, project, request), bindingId, body);
  }

  @Post(':bindingId/disable')
  @RequireProjectPermission('service_identity:manage')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBinding> {
    return this.bindings.disable(callerOf(principal, workspace, project, request), bindingId);
  }

  @Post(':bindingId/enable')
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  enable(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcTrustBinding> {
    return this.bindings.enable(callerOf(principal, workspace, project, request), bindingId);
  }

  @Delete(':bindingId')
  @RequireProjectPermission('service_identity:manage')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.bindings.remove(callerOf(principal, workspace, project, request), bindingId);
  }

  @Get(':bindingId/attempts')
  @RequireProjectPermission('service_identity:read')
  @AllowArchived('workspace', 'project')
  attempts(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @CurrentProject() project: AuthorizedProject,
    @UuidParam('bindingId') bindingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OidcBindingAttemptList> {
    return this.bindings.attempts(callerOf(principal, workspace, project, request), bindingId);
  }
}
