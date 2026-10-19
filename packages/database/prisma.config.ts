import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env files automatically. For local development we
// load the repository root .env (never committed) if it exists. Variables that
// are already set in the environment take precedence.
const rootEnvFile = new URL('../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

export default defineConfig({
  // Multi-file schema: every *.prisma file in this folder.
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
    // Development-only seed; refuses to run when NODE_ENV=production.
    seed: 'node dist/seed/run.js',
  },
  datasource: {
    // CLI connection (migrate, studio, seed). With Neon, set DIRECT_URL to the
    // direct (non-pooled) connection string: migrations need a session-level
    // connection that the pooler does not provide. The app uses DATABASE_URL.
    // `prisma generate`/`validate` need no connection.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});
