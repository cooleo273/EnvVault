import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  checkDatabaseHealth,
  createPrismaClient,
  type DatabaseHealth,
  type PrismaClient,
} from '@envvault/database';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * Owns the application's Prisma client. The client connects lazily on the
 * first query, so the API can start (and report liveness) while the database
 * is still unavailable; readiness reports the actual database state.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_ENV) env: Env) {
    this.client = createPrismaClient({
      connectionString: env.DATABASE_URL,
      applicationName: 'envvault-api',
      connectionTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: env.DATABASE_QUERY_TIMEOUT_MS,
      ...(env.DATABASE_POOL_MAX === undefined ? {} : { maxConnections: env.DATABASE_POOL_MAX }),
    });
  }

  /** Connectivity + migration state, with a bounded timeout. */
  health(): Promise<DatabaseHealth> {
    return checkDatabaseHealth(this.client, { timeoutMs: 2_000 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
