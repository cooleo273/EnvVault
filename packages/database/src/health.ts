import type { DbClient } from './client.js';

export type DatabaseHealthReason =
  'unreachable' | 'timeout' | 'migrations_missing' | 'migrations_failed';

export interface DatabaseHealth {
  status: 'up' | 'down';
  latencyMs?: number;
  /** Internal diagnostic. Do not expose to unauthenticated clients. */
  reason?: DatabaseHealthReason;
}

class HealthTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HealthTimeoutError());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Readiness check: the database is reachable within `timeoutMs` and the
 * schema has been migrated without failed or unfinished migrations.
 * Errors are never rethrown or returned verbatim (they may contain hostnames).
 */
export async function checkDatabaseHealth(
  client: Pick<DbClient, '$queryRaw'>,
  options: { timeoutMs?: number } = {},
): Promise<DatabaseHealth> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const startedAt = performance.now();

  try {
    await withTimeout(client.$queryRaw`SELECT 1`, timeoutMs);
  } catch (error) {
    return {
      status: 'down',
      reason: error instanceof HealthTimeoutError ? 'timeout' : 'unreachable',
    };
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  try {
    const rows = await withTimeout(
      client.$queryRaw<{ incomplete: number }[]>`
        SELECT count(*)::int AS incomplete
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`,
      timeoutMs,
    );
    if ((rows[0]?.incomplete ?? 0) > 0) {
      return { status: 'down', latencyMs, reason: 'migrations_failed' };
    }
  } catch {
    // The migrations table does not exist: the database was never migrated.
    return { status: 'down', latencyMs, reason: 'migrations_missing' };
  }

  return { status: 'up', latencyMs };
}
