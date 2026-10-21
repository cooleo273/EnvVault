import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { summarizeDatabaseError } from '@envvault/database';
import { sealPending } from '../audit/audit-chain.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { INTEGRITY_RUNTIME, type IntegrityRuntime } from './integrity.config.js';

/** Seals new audit events on an interval when an integrity key file is configured. */
@Injectable()
export class AuditSealerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AuditSealer');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(INTEGRITY_RUNTIME) private readonly integrity: IntegrityRuntime,
    @Inject(APP_ENV) private readonly env: Env,
    private readonly database: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.integrity.status !== 'configured' || this.env.AUDIT_SEAL_INTERVAL_SECONDS === 0)
      return;
    this.timer = setInterval(() => void this.tick(), this.env.AUDIT_SEAL_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running || this.integrity.status !== 'configured') return;
    this.running = true;
    try {
      const { sealed } = await sealPending(this.database.client, this.integrity.keys);
      if (sealed > 0) this.logger.log(`Sealed ${String(sealed)} audit events`);
    } catch (error) {
      const database = summarizeDatabaseError(error);
      // The next tick retries; nothing is lost because unsealed events stay in place.
      this.logger.warn(
        `Audit sealing failed (${database?.code ?? database?.type ?? 'unexpected'})`,
      );
    } finally {
      this.running = false;
    }
  }
}
