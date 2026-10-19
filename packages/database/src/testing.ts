/**
 * Test-only helpers (exported as `@envvault/database/testing`). Never import
 * from production code.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, type PrismaClient } from './client.js';

/** Directory of this package (contains prisma.config.ts and migrations). */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Recreates the `public` schema of a disposable database and applies all
 * migrations. Refuses to touch a database whose name does not contain "test".
 * Only `public` is dropped; other schemas (e.g. Neon's `neon_auth`) are left alone.
 */
export async function resetTestDatabase(url: string | undefined): Promise<void> {
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL must point to a disposable PostgreSQL database to run integration tests.',
    );
  }
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(databaseName)) {
    throw new Error(`Refusing to reset database "${databaseName}": its name must contain "test".`);
  }

  const client = createPrismaClient({
    connectionString: url,
    applicationName: 'envvault-test-setup',
  });
  try {
    await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await client.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await client.$disconnect();
  }

  // prisma.config.ts prefers DIRECT_URL and loads the root .env for unset
  // variables, so both must be pinned to the disposable database; otherwise
  // migrations would run against the developer's real (e.g. Neon) database.
  execSync('pnpm exec prisma migrate deploy', {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}

/**
 * Empties every table in `public`. Runs with session_replication_role =
 * replica so the append-only audit triggers do not block cleanup (requires a
 * superuser, which disposable test databases have).
 */
export async function truncateAllTables(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  });
}
