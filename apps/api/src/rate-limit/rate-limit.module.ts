import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { ResilientThrottlerStorage } from './resilient.storage.js';
import { RATE_LIMIT_STORAGE, SensitiveRateLimiter } from './sensitive-rate-limiter.js';
import { UserRateLimitGuard } from './user-rate-limit.guard.js';

export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

/** Redis with fail fast settings: a hung store must not hang requests. */
export function createRateLimitRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_REDIS,
      inject: [APP_ENV],
      useFactory: (env: Env): Redis | null => {
        if (env.RATE_LIMIT_STORE !== 'redis' || !env.REDIS_URL) return null;
        const redis = createRateLimitRedis(env.REDIS_URL);
        // Connection errors surface per command; logging each one would flood the log.
        redis.on('error', () => undefined);
        return redis;
      },
    },
    {
      provide: RATE_LIMIT_STORAGE,
      inject: [APP_ENV, RATE_LIMIT_REDIS],
      useFactory: (env: Env, redis: Redis | null) => {
        const memory = new ThrottlerStorageService();
        return redis
          ? new ResilientThrottlerStorage(
              new RedisThrottlerStorage(redis, env.RATE_LIMIT_KEY_PREFIX),
              memory,
              true,
            )
          : new ResilientThrottlerStorage(memory, memory, false);
      },
    },
    SensitiveRateLimiter,
    UserRateLimitGuard,
  ],
  exports: [RATE_LIMIT_STORAGE, RATE_LIMIT_REDIS, SensitiveRateLimiter, UserRateLimitGuard],
})
export class RateLimitModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitModule.name);

  constructor(@Inject(RATE_LIMIT_REDIS) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.redis) return;
    await this.redis.quit().catch(() => {
      this.logger.warn('Rate limit store did not close cleanly');
    });
  }
}
