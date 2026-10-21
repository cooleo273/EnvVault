import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/api-exception.js';
import type { SecretRequestContext } from './secret-authorization.service.js';
import { SecretVault } from './secret-vault.service.js';

const WINDOW_MS = 60_000;

export type SensitiveRead = 'reveal' | 'bulk-read';

/**
 * Per user (and, for reveals, per user and variable) limits on reading
 * plaintext. The IP based throttler cannot do this: every request reaches
 * the API from the web server's address. Counters live in the throttler's
 * storage, which is in memory and per instance: with several API replicas
 * each one counts separately until a shared store (Redis) is configured.
 */
@Injectable()
export class SecretRateLimiter {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(APP_ENV) private readonly env: Env,
    private readonly vault: SecretVault,
  ) {}

  async consume(
    ctx: SecretRequestContext,
    kind: SensitiveRead,
    resourceId?: string,
  ): Promise<void> {
    const user = ctx.principal.userId;
    const checks: [string, number][] =
      kind === 'reveal'
        ? [
            [`secret-reveal:user:${user}`, this.env.SECRET_REVEAL_RATE_LIMIT],
            ...(resourceId
              ? ([
                  [
                    `secret-reveal:user:${user}:secret:${resourceId}`,
                    this.env.SECRET_REVEAL_RESOURCE_RATE_LIMIT,
                  ],
                ] as [string, number][])
              : []),
          ]
        : [[`secret-bulk-read:user:${user}`, this.env.SECRET_BULK_READ_RATE_LIMIT]];
    for (const [key, limit] of checks) {
      const record = await this.storage.increment(key, WINDOW_MS, limit, WINDOW_MS, 'secret-reads');
      if (!record.isBlocked) continue;
      // Audit only the first refusal of a block: a one hit counter that
      // lives as long as the block, so a flood cannot also flood the log.
      const marker = await this.storage.increment(
        `${key}:audited`,
        Math.max(1, record.timeToBlockExpire) * 1000,
        1,
        0,
        'secret-reads',
      );
      if (!marker.isBlocked) {
        await this.vault
          .audit(
            this.vault.repos,
            ctx,
            'secret.access_denied',
            resourceId ?? null,
            {
              attempted: kind === 'reveal' ? 'secret.revealed' : 'secret.bulk_read',
              reason: 'rate_limited',
            },
            { outcome: 'DENIED' },
          )
          .catch(() => undefined);
      }
      const seconds = Math.max(1, record.timeToBlockExpire);
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_REQUESTS',
        'Too many values were read in a short time. Wait a minute and try again.',
        { 'Retry-After': String(seconds) },
      );
    }
  }
}
