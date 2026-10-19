import { defineConfig } from 'vitest/config';

// API integration tests: full application + real PostgreSQL (TEST_DATABASE_URL)
// + an in-process fake Neon Auth branch.
export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
