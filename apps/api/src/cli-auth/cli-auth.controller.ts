import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  CLI_ERROR_CODES,
  type CliDeviceRequest,
  type CliDeviceStart,
  type CliDeviceStartInput,
  cliDeviceStartInputSchema,
  cliDeviceTokenInputSchema,
  cliRefreshInputSchema,
  type CliSession,
  type CliToken,
  cliUserCodeInputSchema,
  USER_CODE_PATTERN,
} from '@envvault/shared';
import type { z } from 'zod';
import {
  AllowCliToken,
  Authenticated,
  CurrentPrincipal,
  Public,
  RequireStepUp,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { SensitiveRateLimit } from '../common/sensitive-rate-limit.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';
import { CliAuthService } from './cli-auth.service.js';

type CodeInput = z.output<typeof cliUserCodeInputSchema>;

/** Browser approved CLI sign in and CLI session management. */
@Controller({ path: 'cli', version: '1' })
@UseInterceptors(NoStoreInterceptor)
export class CliAuthController {
  constructor(private readonly cli: CliAuthService) {}

  /** Step 1 (CLI): open a sign in request. Rate limited per client address. */
  @Post('device/authorize')
  @HttpCode(HttpStatus.OK)
  @Public()
  @SensitiveRateLimit()
  start(
    @Body(new ZodValidationPipe(cliDeviceStartInputSchema)) body: CliDeviceStartInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<CliDeviceStart> {
    return this.cli.start(body, request.ip ?? null);
  }

  /** Step 3 (CLI): poll until approved, then receive the session tokens. */
  @Post('device/token')
  @HttpCode(HttpStatus.OK)
  @Public()
  poll(
    @Body(new ZodValidationPipe(cliDeviceTokenInputSchema))
    body: z.output<typeof cliDeviceTokenInputSchema>,
  ): Promise<CliToken> {
    return this.cli.poll(body.deviceCode);
  }

  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  @Public()
  @SensitiveRateLimit()
  refresh(
    @Body(new ZodValidationPipe(cliRefreshInputSchema))
    body: z.output<typeof cliRefreshInputSchema>,
  ): Promise<CliToken> {
    return this.cli.refresh(body.refreshToken);
  }

  /** Step 2 (web): what is asking to sign in. */
  @Get('device/:userCode')
  @Authenticated()
  lookup(@Param('userCode') userCode: string): Promise<CliDeviceRequest> {
    const code = userCode.trim().toUpperCase();
    if (!USER_CODE_PATTERN.test(code)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'No open sign in request has this code.',
      );
    }
    return this.cli.lookup(code);
  }

  /** Step 2 (web): approve, with a recent password confirmation. */
  @Post('device/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @RequireStepUp()
  @LimitSensitiveAction('cli-approve')
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(cliUserCodeInputSchema)) body: CodeInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.cli.decide(principal, body.userCode, 'approved', requestIdOf(request));
  }

  @Post('device/deny')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @LimitSensitiveAction('cli-approve')
  async deny(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(cliUserCodeInputSchema)) body: CodeInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.cli.decide(principal, body.userCode, 'denied', requestIdOf(request));
  }

  @Get('sessions')
  @Authenticated()
  @AllowCliToken()
  async sessions(@CurrentPrincipal() principal: Principal): Promise<{ items: CliSession[] }> {
    return { items: await this.cli.sessions(principal) };
  }

  /** envvault logout: ends the calling CLI session. */
  @Post('sessions/current/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @AllowCliToken()
  async revokeCurrent(
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    if (!principal.cliSessionId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        CLI_ERROR_CODES.CLI_TOKEN_NOT_ALLOWED,
        'Only a CLI session can end itself here',
      );
    }
    await this.cli.revoke(principal, principal.cliSessionId, 'logout', requestIdOf(request));
  }

  /** Ends another CLI session of the same user (account settings). */
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.cli.revoke(principal, sessionId, 'user_revoked', requestIdOf(request));
  }
}
