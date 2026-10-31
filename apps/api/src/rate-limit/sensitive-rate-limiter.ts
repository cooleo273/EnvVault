import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/api-exception.js';
import { RateLimitUnavailableError, type ResilientThrottlerStorage } from './resilient.storage.js';

export const RATE_LIMIT_STORAGE = Symbol('RATE_LIMIT_STORAGE');

/** Actions with their own per user (and optionally per resource) limits. */
export type SensitiveAction =
  | 'reveal'
  | 'bulk-read'
  | 'import'
  | 'bulk-write'
  | 'rollback'
  | 'restore'
  | 'access-change'
  | 'step-up'
  | 'runtime'
  | 'cli-approve'
  | 'machine-token'
  | 'machine-runtime'
  | 'credential-issue'
  | 'oidc-token'
  | 'integration-sync'
  | 'integration-change';

interface Rule {
  limit: number;
  windowMs: number;
  resourceLimit?: number;
}

const MESSAGES: Record<SensitiveAction, string> = {
  reveal: 'Too many values were read in a short time. Wait a minute and try again.',
  'bulk-read': 'Too many values were read in a short time. Wait a minute and try again.',
  import: 'Too many imports in a short time. Wait a minute and try again.',
  'bulk-write': 'Too many bulk changes in a short time. Wait a minute and try again.',
  rollback: 'Too many restores in a short time. Wait a minute and try again.',
  restore: 'Too many snapshot restores in a short time. Wait a minute and try again.',
  'access-change': 'Too many access changes in a short time. Wait a minute and try again.',
  'step-up': 'Too many password confirmations. Wait a few minutes and try again.',
  runtime: 'Too many runs loaded values in a short time. Wait a minute and try again.',
  'cli-approve': 'Too many CLI sign in approvals. Wait a few minutes and try again.',
  'machine-token': 'Too many token requests for this credential. Wait a minute and try again.',
  'machine-runtime':
    'Too many runtime loads by this machine identity. Wait a minute and try again.',
  'credential-issue':
    'Too many credentials issued in a short time. Wait a few minutes and try again.',
  'oidc-token': 'Too many token requests from this repository. Wait a minute and try again.',
  'integration-sync': 'Too many synchronisations in a short time. Wait a minute and try again.',
  'integration-change':
    'Too many integration changes in a short time. Wait a few minutes and try again.',
};

export interface ConsumeInput {
  /** The person, or `machine:<identity id>` / `credential:<lookup id>` for machines. */
  userId: string;
  action: SensitiveAction;
  /** A variable, environment or similar; limits the same target separately. */
  resourceId?: string | undefined;
  /** Records the first refusal of a block (never called again while it lasts). */
  onBlocked?: () => Promise<void>;
}

/**
 * Per user limits on sensitive actions, counted in the shared store when one
 * is configured. Callers consume after authorization, so a 429 never tells
 * an unauthorized caller anything about the resource. When the shared store
 * is down these actions are refused (503), never counted per instance.
 */
@Injectable()
export class SensitiveRateLimiter {
  private readonly logger = new Logger(SensitiveRateLimiter.name);
  private readonly rules: Record<SensitiveAction, Rule>;

  constructor(
    @Inject(RATE_LIMIT_STORAGE) private readonly storage: ResilientThrottlerStorage,
    @Inject(APP_ENV) env: Env,
  ) {
    const minute = 60_000;
    this.rules = {
      reveal: {
        limit: env.SECRET_REVEAL_RATE_LIMIT,
        windowMs: minute,
        resourceLimit: env.SECRET_REVEAL_RESOURCE_RATE_LIMIT,
      },
      'bulk-read': { limit: env.SECRET_BULK_READ_RATE_LIMIT, windowMs: minute },
      import: { limit: env.SECRET_IMPORT_RATE_LIMIT, windowMs: minute },
      'bulk-write': { limit: env.SECRET_BULK_WRITE_RATE_LIMIT, windowMs: minute },
      rollback: { limit: env.SECRET_ROLLBACK_RATE_LIMIT, windowMs: minute },
      restore: { limit: env.SNAPSHOT_RESTORE_RATE_LIMIT, windowMs: minute },
      'access-change': { limit: env.ACCESS_CHANGE_RATE_LIMIT, windowMs: minute },
      'step-up': { limit: env.STEP_UP_RATE_LIMIT, windowMs: 5 * minute },
      runtime: {
        limit: env.SECRET_RUNTIME_RATE_LIMIT,
        windowMs: minute,
        resourceLimit: env.SECRET_RUNTIME_RESOURCE_RATE_LIMIT,
      },
      'cli-approve': { limit: 10, windowMs: 5 * minute },
      'machine-token': { limit: env.MACHINE_TOKEN_RATE_LIMIT, windowMs: minute },
      'machine-runtime': {
        limit: env.MACHINE_RUNTIME_RATE_LIMIT,
        windowMs: minute,
        resourceLimit: env.MACHINE_RUNTIME_RESOURCE_RATE_LIMIT,
      },
      'credential-issue': { limit: 20, windowMs: 5 * minute },
      'oidc-token': { limit: env.OIDC_TOKEN_RATE_LIMIT, windowMs: minute },
      'integration-sync': { limit: env.INTEGRATION_SYNC_RATE_LIMIT, windowMs: minute },
      'integration-change': { limit: 30, windowMs: 5 * minute },
    };
  }

  /**
   * True the first time `key` is seen within `ttlMs`, false afterwards. Counted
   * in the shared store, so it holds across instances only when one is
   * configured (RATE_LIMIT_STORE=redis); refused (503) when that store is down.
   */
  async claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const record = await this.hit(`once:${key}`, ttlMs, 1, ttlMs);
    return !record.isBlocked;
  }

  async consume(input: ConsumeInput): Promise<void> {
    const rule = this.rules[input.action];
    const base = `${input.action}:user:${input.userId}`;
    const checks: [string, number][] = [[base, rule.limit]];
    if (rule.resourceLimit !== undefined && input.resourceId) {
      checks.push([`${base}:resource:${input.resourceId}`, rule.resourceLimit]);
    }
    for (const [key, limit] of checks) {
      const record = await this.hit(key, rule.windowMs, limit, rule.windowMs);
      if (!record.isBlocked) continue;
      const seconds = Math.max(1, record.timeToBlockExpire);
      // A one hit marker that lives as long as the block: a flood is recorded once.
      const marker = await this.hit(`${key}:audited`, seconds * 1000, 1, 0).catch(() => null);
      if (marker && !marker.isBlocked) {
        await input.onBlocked?.().catch(() => {
          this.logger.error(`Could not record a rate limited ${input.action}`);
        });
      }
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_REQUESTS',
        MESSAGES[input.action],
        {
          'Retry-After': String(seconds),
        },
      );
    }
  }

  private async hit(key: string, ttl: number, limit: number, blockDuration: number) {
    try {
      return await this.storage.incrementStrict(
        key,
        ttl,
        limit,
        blockDuration,
        'sensitive-actions',
      );
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'RATE_LIMIT_UNAVAILABLE',
          'This action is paused because its limits cannot be checked right now. Try again shortly.',
          { 'Retry-After': '30' },
        );
      }
      throw error;
    }
  }
}
