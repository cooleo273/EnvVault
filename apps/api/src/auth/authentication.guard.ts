import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRepositories } from '@envvault/database';
import { AUTH_ERROR_CODES } from '@envvault/shared';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { ALLOW_UNVERIFIED_EMAIL_KEY, IS_PUBLIC_KEY } from './auth.decorators.js';
import { TOKEN_VERIFIER } from './auth.tokens.js';
import { extractBearerToken } from './bearer-token.js';
import { type NeonTokenVerifier, TokenVerificationError } from './neon-token.verifier.js';
import type { AuthenticatedRequest } from './principal.js';

function unauthorized(code: string, message: string, error = 'invalid_token'): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, code, message, {
    'WWW-Authenticate': `Bearer error="${error}"`,
  });
}

/**
 * Global guard: every route requires a valid Neon Auth access token unless
 * marked @Public(). Establishes the request principal from the verified
 * token only; client-supplied user ids (headers, body, query) are ignored.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: NeonTokenVerifier,
    private readonly database: DatabaseService,
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
}
