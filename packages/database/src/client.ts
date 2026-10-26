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
  /**
   * How long an unused pooled connection stays open. A new connection to a
   * remote database (e.g. Neon over TLS) costs several round trips (~1 s),
   * so idle connections are kept for 5 minutes by default instead of
   * node-postgres's 10 seconds.
   */
  idleTimeoutMs?: number;
  /**
   * Client side limit per query. The driver stops waiting and frees the
   * connection; the server may still finish the statement. Unset means no
   * limit (node-postgres's default).
   */
  queryTimeoutMs?: number;
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
    idleTimeoutMillis: options.idleTimeoutMs ?? 300_000,
    keepAlive: true,
    ...(options.queryTimeoutMs === undefined ? {} : { query_timeout: options.queryTimeoutMs }),
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  // Prisma's own console logging is disabled: it bypasses the application's
  // structured logger and query logs may contain sensitive parameters. Errors
  // still propagate to callers, which log them through the app logger.
  // Minimal errors leave out the call site rendering, which quotes arguments.
  return new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
}

/** The root client or an interactive-transaction client; repositories accept either. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export { PrismaClient };
