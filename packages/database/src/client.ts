import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  /** PostgreSQL connection string. Must come from validated configuration, never hardcoded. */
  connectionString: string;
  /** Maximum number of pooled connections. */
  maxConnections?: number;
  /** Reported in pg_stat_activity to identify the service. */
  applicationName?: string;
  /** How long to wait for a new connection before failing. */
  connectionTimeoutMs?: number;
}

/**
 * Creates a Prisma client backed by the node-postgres driver adapter.
 * Connections are established lazily on first query.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  if (!options.connectionString) {
    throw new Error('A database connection string is required');
  }
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'envvault',
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  // Prisma's own console logging is disabled: it bypasses the application's
  // structured logger and query logs may contain sensitive parameters. Errors
  // still propagate to callers, which log them through the app logger.
  return new PrismaClient({ adapter, log: [] });
}

/** The root client or an interactive-transaction client; repositories accept either. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export { PrismaClient };
