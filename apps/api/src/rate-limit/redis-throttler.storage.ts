import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * One atomic step per hit: count it in a fixed window, start a block when
 * the count passes the limit, and report both remaining times. Running it
 * as one script keeps concurrent API instances from racing each other.
 */
const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local block = redis.call('PTTL', KEYS[2])
local limit = tonumber(ARGV[2])
local duration = tonumber(ARGV[3])
if block <= 0 and hits > limit and duration > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', duration)
  block = duration
end
if block < 0 then block = 0 end
return { hits, ttl, block }
`;

/** Shared throttler storage, so every API instance counts against the same limits. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}${throttlerName}:${key}`;
    const result = (await this.redis.eval(
      HIT_SCRIPT,
      2,
      base,
      `${base}:blocked`,
      String(Math.max(1, ttl)),
      String(limit),
      String(Math.max(0, blockDuration)),
    )) as [number, number, number];
    const [totalHits, ttlMs, blockMs] = result.map(Number) as [number, number, number];
    const isBlocked = blockDuration > 0 ? blockMs > 0 : totalHits > limit;
    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.max(1, Math.ceil((blockMs || ttlMs) / 1000)) : 0,
    };
  }
}
