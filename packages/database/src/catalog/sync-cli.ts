import { existsSync } from 'node:fs';
import { createPrismaClient } from '../client.js';
import { syncAllWorkspaceRoles } from './provisioning.js';

// Entry point for `pnpm db:sync-catalog`: run after `db:migrate:deploy`.
// Like the Prisma CLI it prefers DIRECT_URL (Neon: the non-pooled URL).
const rootEnvFile = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write('DIRECT_URL or DATABASE_URL must be set\n');
  process.exit(1);
}

const client = createPrismaClient({ connectionString, applicationName: 'envvault-sync-catalog' });
try {
  const { workspaces } = await syncAllWorkspaceRoles(client);
  process.stdout.write(
    `Synchronised permissions and built-in roles for ${String(workspaces)} workspaces.\n`,
  );
} catch (error) {
  process.stderr.write(`Sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
