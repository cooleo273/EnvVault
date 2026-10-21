import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { createRepositories } from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  type LogoutInput,
  logoutInputSchema,
  type RevokeTokensInput,
  revokeTokensInputSchema,
  type StepUpInput,
  stepUpInputSchema,
  type StepUpStatus,
} from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { AllowUnverifiedEmail, Authenticated, CurrentPrincipal } from './auth.decorators.js';
import { CREDENTIAL_VERIFIER } from './auth.tokens.js';
import type { CredentialVerifier } from './credential.verifier.js';
import type { AuthenticatedRequest, Principal } from './principal.js';
import { LimitSensitiveAction } from '../rate-limit/sensitive-action.guard.js';

@Controller({ version: '1' })
export class AuthController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(CREDENTIAL_VERIFIER) private readonly credentials: CredentialVerifier,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /**
   * Revokes the caller's API access tokens issued until now and ends step-up.
   * Called by the web app right before it ends the Neon Auth session(s).
   * Access tokens are stateless JWTs, so without this a token copied before
   * logout would stay valid for up to 15 minutes.
   */
  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @AllowUnverifiedEmail()
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(logoutInputSchema)) body: LogoutInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const repos = createRepositories(this.database.client);
    await repos.authState.revokeTokensIssuedBefore(
      principal.userId,
      body.scope === 'all' ? 'LOGOUT_ALL_DEVICES' : 'LOGOUT',
    );
    await repos.authState.clearStepUpGrants(principal.userId);
    await repos.audit.append({
      actorUserId: principal.userId,
      action: body.scope === 'all' ? 'auth.logout_all_devices' : 'auth.logout',
      outcome: 'SUCCESS',
      resourceType: 'user',
      resourceId: principal.userId,
      requestId: requestIdOf(request),
    });
  }

  /**
   * After a security change made directly with Neon Auth (password change,
   * signing out other sessions), revokes every access token issued so far.
   * Self-service and harmless: the current device mints a new token.
   */
  @Post('auth/tokens/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  async revokeTokens(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(revokeTokensInputSchema)) body: RevokeTokensInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const repos = createRepositories(this.database.client);
    const reason = body.reason === 'password_changed' ? 'PASSWORD_CHANGED' : 'LOGOUT_ALL_DEVICES';
    await repos.authState.revokeTokensIssuedBefore(principal.userId, reason);
    await repos.authState.clearStepUpGrants(principal.userId);
    await repos.audit.append({
      actorUserId: principal.userId,
      action:
        body.reason === 'password_changed' ? 'auth.password_changed' : 'auth.sessions_revoked',
      outcome: 'SUCCESS',
      resourceType: 'user',
      resourceId: principal.userId,
      requestId: requestIdOf(request),
    });
  }

  @Get('auth/step-up')
  @Authenticated()
  async stepUpStatus(@CurrentPrincipal() principal: Principal): Promise<StepUpStatus> {
    const expiresAt = await createRepositories(
      this.database.client,
    ).authState.findActiveStepUpExpiry(principal.userId);
    return { active: expiresAt !== null, expiresAt: expiresAt?.toISOString() ?? null };
  }

  /**
   * Step-up ("sudo mode"): re-verifies the caller's password with Neon Auth
   * and grants a short window for sensitive actions. Strictly rate limited.
   */
  @Post('auth/step-up')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @LimitSensitiveAction('step-up')
  async stepUp(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(stepUpInputSchema)) body: StepUpInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<StepUpStatus> {
    const repos = createRepositories(this.database.client);
    const result = await this.credentials.verifyPassword({
      authUserId: principal.authUserId,
      email: principal.email,
      password: body.password,
    });

    if (result === 'unavailable') {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        AUTH_ERROR_CODES.AUTH_UNAVAILABLE,
        'Could not verify your password right now. Try again shortly.',
      );
    }

    const audit = {
      actorUserId: principal.userId,
      resourceType: 'user',
      resourceId: principal.userId,
      requestId: requestIdOf(request),
      metadata: { method: 'PASSWORD' },
    };

    if (result === 'invalid') {
      await repos.audit.append({ ...audit, action: 'auth.step_up.failed', outcome: 'DENIED' });
      // 403, not 401: the session is still valid, only the re-check failed.
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.STEP_UP_FAILED,
        'Incorrect password',
      );
    }

    const { expiresAt } = await repos.authState.createStepUpGrant(
      principal.userId,
      'PASSWORD',
      this.env.AUTH_STEP_UP_TTL_SECONDS,
    );
    await repos.audit.append({ ...audit, action: 'auth.step_up.succeeded', outcome: 'SUCCESS' });
    return { active: true, expiresAt: expiresAt.toISOString() };
  }
}
