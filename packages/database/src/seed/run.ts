import { existsSync } from 'node:fs';
import { createPrismaClient } from '../client.js';
import { assertSeedAllowed, seedDevelopmentData } from './seed.js';

// Entry point for `prisma db seed` / `pnpm db:seed` (development only).
const rootEnvFile = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

assertSeedAllowed();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

const client = createPrismaClient({ connectionString, applicationName: 'envvault-seed' });
try {
  const result = await seedDevelopmentData(client);
  process.stdout.write(
    `Seeded workspace ${result.workspaceId} with ${Object.keys(result.userIds).length} users.\n`,
  );
} catch (error) {
  // Print the message only: full Prisma errors can include query details.
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
