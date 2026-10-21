import { Injectable } from '@nestjs/common';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import type { SecretRequestContext } from './secret-authorization.service.js';
import { SecretVault } from './secret-vault.service.js';

export type SecretAction =
  'reveal' | 'bulk-read' | 'import' | 'bulk-write' | 'rollback' | 'restore';

const ATTEMPTED: Record<SecretAction, string> = {
  reveal: 'secret.revealed',
  'bulk-read': 'secret.bulk_read',
  import: 'secret.import_started',
  'bulk-write': 'secret.bulk_updated',
  rollback: 'secret.rolled_back',
  restore: 'environment.snapshot_restored',
};

/**
 * Secret flavoured front of {@link SensitiveRateLimiter}: the first refusal
 * of a block is audited as `secret.access_denied` in the environment, like
 * every other refused secret operation.
 */
@Injectable()
export class SecretRateLimiter {
  constructor(
    private readonly limiter: SensitiveRateLimiter,
    private readonly vault: SecretVault,
  ) {}

  consume(ctx: SecretRequestContext, action: SecretAction, resourceId?: string): Promise<void> {
    return this.limiter.consume({
      userId: ctx.principal.userId,
      action,
      resourceId,
      onBlocked: () =>
        this.vault.audit(
          this.vault.repos,
          ctx,
          'secret.access_denied',
          resourceId ?? null,
          { attempted: ATTEMPTED[action], reason: 'rate_limited' },
          { outcome: 'DENIED' },
        ),
    });
  }
}
