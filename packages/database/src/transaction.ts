import { Prisma, type PrismaClient } from './generated/prisma/client.js';

export interface TransactionOptions {
  /** Defaults to READ COMMITTED (PostgreSQL's default). */
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Retries after serialization failures / deadlocks (Prisma P2034). Default 2. */
  maxRetries?: number;
  /** Maximum transaction duration. Default 10 s. */
  timeoutMs?: number;
  /** Maximum time to wait for a connection. Default 5 s. */
  maxWaitMs?: number;
}

/** Prisma error code for write conflicts, deadlocks and serialization failures. */
const RETRYABLE_ERROR_CODES = new Set(['P2034']);

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && RETRYABLE_ERROR_CODES.has(error.code)
  );
}

type TransactionCapable = Pick<PrismaClient, '$transaction'>;

/**
 * Runs `fn` in an interactive transaction. Every multi-record write (e.g.
 * creating a secret version and moving `current_version_id`) must go through
 * this helper so it commits or rolls back atomically. Conflicts that are safe
 * to retry are retried; the callback must therefore be free of external side
 * effects (no KMS calls with side effects, no network I/O, no audit emission
 * outside the transaction).
 */
export async function withTransaction<T>(
  client: TransactionCapable,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const {
    isolationLevel = Prisma.TransactionIsolationLevel.ReadCommitted,
    maxRetries = 2,
    timeoutMs = 10_000,
    maxWaitMs = 5_000,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(fn, {
        isolationLevel,
        timeout: timeoutMs,
        maxWait: maxWaitMs,
      });
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }
}
