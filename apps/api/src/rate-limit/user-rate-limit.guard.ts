import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { RATE_LIMIT_STORAGE } from './sensitive-rate-limiter.js';
import type { ResilientThrottlerStorage } from './resilient.storage.js';

const WINDOW_MS = 60_000;

/**
 * General per user limit, after authentication. Requests from browsers all
 * reach the API from the web server's address, so the IP limit cannot tell
 * users apart; this one does. Falls back to per instance counting when the
 * shared store is down.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMIT_STORAGE) private readonly storage: ResilientThrottlerStorage,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.principal?.userId;
    if (!userId) return true;
    const record = await this.storage.increment(
      `user:${userId}`,
      WINDOW_MS,
      this.env.RATE_LIMIT_USER_MAX,
      WINDOW_MS,
      'user',
    );
    if (!record.isBlocked) return true;
    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      'TOO_MANY_REQUESTS',
      'Too many requests. Wait a minute and try again.',
      { 'Retry-After': String(Math.max(1, record.timeToBlockExpire)) },
    );
  }
}
