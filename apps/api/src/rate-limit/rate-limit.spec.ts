import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import { parseEnv } from '../config/env.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { ResilientThrottlerStorage } from './resilient.storage.js';
import { SensitiveRateLimiter } from './sensitive-rate-limiter.js';

const env = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://envvault:placeholder@localhost:5432/envvault',
  CORS_ORIGINS: 'http://localhost:3000',
  NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
  SNAPSHOT_RESTORE_RATE_LIMIT: '2',
  SECRET_REVEAL_RATE_LIMIT: '10',
  SECRET_REVEAL_RESOURCE_RATE_LIMIT: '2',
});

function redis(): Redis {
  return new (RedisMock as new () => Redis)();
}

const failing = {
  increment: () => Promise.reject(new Error('connection refused')),
};

describe('RedisThrottlerStorage', () => {
  it('counts hits in a shared window and blocks past the limit', async () => {
    const shared = redis();
    const a = new RedisThrottlerStorage(shared, 'test:');
    const b = new RedisThrottlerStorage(shared, 'test:');
    expect((await a.increment('k', 60_000, 2, 60_000, 'n')).isBlocked).toBe(false);
    expect((await b.increment('k', 60_000, 2, 60_000, 'n')).isBlocked).toBe(false);
    const third = await a.increment('k', 60_000, 2, 60_000, 'n');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true });
    expect(third.timeToBlockExpire).toBeGreaterThan(0);
    expect(third.timeToBlockExpire).toBeLessThanOrEqual(60);
    expect((await b.increment('other', 60_000, 2, 60_000, 'n')).isBlocked).toBe(false);
  });

  it('without a block duration, refuses only while over the limit', async () => {
    const storage = new RedisThrottlerStorage(redis(), 'test:');
    expect((await storage.increment('marker', 5_000, 1, 0, 'n')).isBlocked).toBe(false);
    expect((await storage.increment('marker', 5_000, 1, 0, 'n')).isBlocked).toBe(true);
  });
});

describe('ResilientThrottlerStorage', () => {
  it('falls back to per instance counting for general limits', async () => {
    const storage = new ResilientThrottlerStorage(failing, new ThrottlerStorageService(), true);
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');
    expect(record).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('refuses sensitive actions when the shared store is down', async () => {
    const storage = new ResilientThrottlerStorage(failing, new ThrottlerStorageService(), true);
    const limiter = new SensitiveRateLimiter(storage, env);
    const error = await limiter
      .consume({ userId: 'u1', action: 'restore' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((error as ApiException).code).toBe('RATE_LIMIT_UNAVAILABLE');
  });
});

describe('SensitiveRateLimiter', () => {
  function limiter() {
    const shared = new RedisThrottlerStorage(redis(), 'test:');
    return new SensitiveRateLimiter(
      new ResilientThrottlerStorage(shared, new ThrottlerStorageService(), true),
      env,
    );
  }

  it('limits per user, answers 429 with Retry-After and audits the first refusal only', async () => {
    const subject = limiter();
    const onBlocked = vi.fn(() => Promise.resolve());
    await subject.consume({ userId: 'u1', action: 'restore', onBlocked });
    await subject.consume({ userId: 'u1', action: 'restore', onBlocked });
    for (let i = 0; i < 3; i++) {
      const error = await subject
        .consume({ userId: 'u1', action: 'restore', onBlocked })
        .catch((caught: unknown) => caught);
      expect((error as ApiException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const retryAfter = Number((error as ApiException).headers['Retry-After']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    expect(onBlocked).toHaveBeenCalledTimes(1);
    await expect(subject.consume({ userId: 'u2', action: 'restore' })).resolves.toBeUndefined();
  });

  it('limits one resource separately from the user total', async () => {
    const subject = limiter();
    await subject.consume({ userId: 'u1', action: 'reveal', resourceId: 's1' });
    await subject.consume({ userId: 'u1', action: 'reveal', resourceId: 's1' });
    await expect(
      subject.consume({ userId: 'u1', action: 'reveal', resourceId: 's1' }),
    ).rejects.toBeInstanceOf(ApiException);
    await expect(
      subject.consume({ userId: 'u1', action: 'reveal', resourceId: 's2' }),
    ).resolves.toBeUndefined();
  });

  it('uses the same message whether or not the resource exists', async () => {
    const subject = limiter();
    const messages = new Set<string>();
    for (const resourceId of ['exists', 'missing']) {
      for (let i = 0; i < 3; i++) {
        const error = await subject
          .consume({ userId: `u-${resourceId}`, action: 'reveal', resourceId })
          .catch((caught: unknown) => caught);
        if (error instanceof ApiException) messages.add(error.message);
      }
    }
    expect(messages.size).toBe(1);
  });
});
