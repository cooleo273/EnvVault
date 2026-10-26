import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRepositories } from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  CLI_ERROR_CODES,
  MACHINE_ERROR_CODES,
  MACHINE_LIMITS,
} from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { CLI_ACCESS_PREFIX, CliAuthService, tokenHash } from '../cli-auth/cli-auth.service.js';
import { MachineAuthService } from '../machine/machine-auth.service.js';
import {
  ALLOW_UNVERIFIED_EMAIL_KEY,
  CLI_ACCESS_KEY,
  IS_PUBLIC_KEY,
  MACHINE_ROUTE_KEY,
} from './auth.decorators.js';
import { TOKEN_VERIFIER } from './auth.tokens.js';
import { extractBearerToken } from './bearer-token.js';
import { type NeonTokenVerifier, TokenVerificationError } from './neon-token.verifier.js';
import type { AuthenticatedRequest, Principal } from './principal.js';

function unauthorized(code: string, message: string, error = 'invalid_token'): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, code, message, {
    'WWW-Authenticate': `Bearer error="${error}"`,
  });
}

/**
 * Global guard: every route requires a valid Neon Auth access token unless
 * marked @Public(). Establishes the request principal from the verified
 * token only; client-supplied user ids (headers, body, query) are ignored.
 * CLI tokens work only on @AllowCliToken() routes, machine access tokens only
 * on @MachineRoute() routes (which accept nothing else), and service
 * credentials nowhere but the token exchange.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: NeonTokenVerifier,
    private readonly database: DatabaseService,
    private readonly cli: CliAuthService,
    private readonly machines: MachineAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        AUTH_ERROR_CODES.UNAUTHENTICATED,
        'Authentication required',
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    // The long lived credential only ever goes to POST /machine/token.
    if (token.startsWith(MACHINE_LIMITS.credentialPrefix)) {
      throw unauthorized(
        MACHINE_ERROR_CODES.SERVICE_CREDENTIAL_NOT_ACCEPTED,
        'Exchange the service credential at POST /api/v1/machine/token and send the access token instead',
      );
    }
    const machineRoute = this.reflector.getAllAndOverride<boolean>(MACHINE_ROUTE_KEY, targets);
    if (token.startsWith(MACHINE_LIMITS.accessTokenPrefix)) {
      if (!machineRoute) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.MACHINE_TOKEN_NOT_ALLOWED,
          'Machine identities cannot use this route',
        );
      }
      request.machine = await this.machines.authenticate(token);
      return true;
    }
    if (machineRoute) {
      throw unauthorized(
        MACHINE_ERROR_CODES.MACHINE_TOKEN_REQUIRED,
        'This route is for machine identities; send a machine access token',
      );
    }

    if (token.startsWith(CLI_ACCESS_PREFIX)) {
      if (!this.reflector.getAllAndOverride<boolean>(CLI_ACCESS_KEY, targets)) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          CLI_ERROR_CODES.CLI_TOKEN_NOT_ALLOWED,
          'This action is not available to the CLI; use the web app',
        );
      }
      request.principal = await this.cliPrincipal(token);
      return true;
    }

    let verified;
    try {
      verified = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        if (error.reason === 'expired') {
          throw unauthorized(AUTH_ERROR_CODES.TOKEN_EXPIRED, 'Access token expired');
        }
        if (error.reason === 'unavailable') {
          throw new ApiException(
            HttpStatus.SERVICE_UNAVAILABLE,
            AUTH_ERROR_CODES.AUTH_UNAVAILABLE,
            'Authentication is temporarily unavailable',
          );
        }
      }
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_INVALID, 'Invalid access token');
    }

    if (verified.banned) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        'Account disabled',
      );
    }

    const repos = createRepositories(this.database.client);
    const profile = await repos.users.upsertFromIdentity(verified);
    if (profile.status !== 'ACTIVE' || profile.deleted) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        'Account disabled',
      );
    }

    // Logout and "sign out everywhere" invalidate tokens issued before them.
    const notBefore = await repos.authState.getTokensNotBefore(profile.id);
    if (notBefore && verified.issuedAt.getTime() < notBefore.getTime()) {
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_REVOKED, 'Access token revoked');
    }

    const allowUnverified = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_EMAIL_KEY,
      targets,
    );
    if (!verified.emailVerified && !allowUnverified) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
        'Verify your email address to continue',
      );
    }

    request.principal = {
      userId: profile.id,
      authUserId: verified.authUserId,
      email: verified.email,
      emailVerified: verified.emailVerified,
      tokenIssuedAt: verified.issuedAt,
    };
    return true;
  }

  /**
   * A CLI access token: an EnvVault session a Neon Auth user approved in the
   * browser. Checked on every request against the session (revoked,
   * expired), the account (active, verified) and the last "sign out
   * everywhere".
   */
  private async cliPrincipal(token: string): Promise<Principal> {
    const now = new Date();
    const repos = createRepositories(this.database.client);
    const session = await repos.cliAuth.sessionByAccessToken(tokenHash(token));
    if (!session) throw unauthorized(AUTH_ERROR_CODES.TOKEN_INVALID, 'Invalid access token');
    if (session.revokedAt)
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_REVOKED, 'Access token revoked');
    if (session.accessExpiresAt <= now || session.expiresAt <= now) {
      throw unauthorized(AUTH_ERROR_CODES.TOKEN_EXPIRED, 'Access token expired');
    }
    await this.cli.assertUsable(session, now);
    const profile = await repos.users.findProfile(session.userId);
    if (!profile) throw unauthorized(AUTH_ERROR_CODES.TOKEN_INVALID, 'Invalid access token');
    if (!profile.emailVerified) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
        'Verify your email address to continue',
      );
    }
    await repos.cliAuth.touch(session.id, now);
    return {
      userId: profile.id,
      authUserId: profile.authUserId,
      email: profile.email,
      emailVerified: true,
      tokenIssuedAt: session.createdAt,
      cliSessionId: session.id,
    };
  }
}
