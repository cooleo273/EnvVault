import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type MachineEnvironment,
  type MachineSelf,
  type MachineToken,
  machineTokenInputSchema,
  type MachineVariableList,
  type RuntimeConfiguration,
  runtimeConfigurationInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { CurrentMachine, MachineRoute, Public } from '../auth/auth.decorators.js';
import { extractBearerToken } from '../auth/bearer-token.js';
import type { AuthenticatedRequest, MachinePrincipal } from '../auth/principal.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { SensitiveRateLimit } from '../common/sensitive-rate-limit.js';
import { UuidParam } from '../common/uuid-param.js';
import { MachineAccessService } from './machine-access.service.js';
import { MachineAuthService } from './machine-auth.service.js';

/**
 * The machine side of EnvVault. `POST /machine/token` exchanges a service
 * credential (Authorization: Bearer evv_sk_…) for a short lived access token;
 * every other route takes only that access token. Nothing here writes,
 * exports or reveals: runtime values go to the calling process only.
 */
@Controller({ path: 'machine', version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class MachineController {
  constructor(
    private readonly auth: MachineAuthService,
    private readonly access: MachineAccessService,
  ) {}

  /**
   * Public to the authentication guard: the credential is verified here.
   * It is read from the Authorization header only, never from the body, so
   * it cannot end up in request logging of bodies or query strings.
   */
  @Post('token')
  @Public()
  @SensitiveRateLimit()
  @HttpCode(HttpStatus.OK)
  token(
    @Body(new ZodValidationPipe(machineTokenInputSchema))
    body: z.output<typeof machineTokenInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineToken> {
    return this.auth.exchange(
      extractBearerToken(request.headers.authorization) ?? null,
      body,
      request.ip ?? null,
      requestIdOf(request),
    );
  }

  @Post('token/revoke')
  @MachineRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentMachine() machine: MachinePrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.revokeToken(machine, requestIdOf(request));
  }

  @Get('identity')
  @MachineRoute()
  self(@CurrentMachine() machine: MachinePrincipal): Promise<MachineSelf> {
    return this.access.self(machine);
  }

  @Get('environments')
  @MachineRoute()
  async environments(
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ items: MachineEnvironment[] }> {
    return { items: await this.access.environments(machine) };
  }

  @Get('environments/:environmentId')
  @MachineRoute()
  environment(
    @CurrentMachine() machine: MachinePrincipal,
    @UuidParam('environmentId') environmentId: string,
  ): Promise<MachineEnvironment> {
    return this.access.environment(machine, environmentId);
  }

  @Get('environments/:environmentId/variables')
  @MachineRoute()
  variables(
    @CurrentMachine() machine: MachinePrincipal,
    @UuidParam('environmentId') environmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineVariableList> {
    return this.access.variables(machine, environmentId, requestIdOf(request));
  }

  @Post('environments/:environmentId/runtime')
  @MachineRoute()
  @HttpCode(HttpStatus.OK)
  runtime(
    @CurrentMachine() machine: MachinePrincipal,
    @UuidParam('environmentId') environmentId: string,
    @Body(new ZodValidationPipe(runtimeConfigurationInputSchema))
    body: z.output<typeof runtimeConfigurationInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<RuntimeConfiguration> {
    return this.access.runtime(machine, environmentId, body, requestIdOf(request));
  }
}
