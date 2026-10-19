import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local convenience: pick up TEST_DATABASE_URL from the root .env (never
// committed). Variables already set in the environment take precedence.
const rootEnvFile = new URL('../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

// Integration tests against a real PostgreSQL database (TEST_DATABASE_URL).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/integration/global-setup.ts'],
    // All files share one database, so they must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
