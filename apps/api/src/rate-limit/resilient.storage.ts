import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';

const WARN_INTERVAL_MS = 60_000;

export class RateLimitUnavailableError extends Error {
  constructor() {
    super('The shared rate limit store is unavailable');
    this.name = 'RateLimitUnavailableError';
  }
}

/**
 * Storage with a documented failure policy (docs/security-hardening.md):
 *
 * - `increment` (general request limits) falls back to this instance's
 *   memory when the shared store fails, so an outage degrades limits to per
 *   instance counting instead of taking the API down.
 * - `incrementStrict` (sensitive actions) never falls back: the caller
 *   refuses the action, because per instance counters would multiply the
 *   allowance by the number of instances.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private lastWarning = 0;

  constructor(
    private readonly primary: ThrottlerStorage,
    private readonly fallback: ThrottlerStorage,
    readonly shared: boolean,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch {
      this.warn();
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  async incrementStrict(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch {
      this.warn();
      throw new RateLimitUnavailableError();
    }
  }

  private warn(): void {
    const now = Date.now();
    if (now - this.lastWarning < WARN_INTERVAL_MS) return;
    this.lastWarning = now;
    this.logger.warn(
      'Shared rate limit store unavailable: general limits are per instance, sensitive actions are refused',
    );
  }
}
