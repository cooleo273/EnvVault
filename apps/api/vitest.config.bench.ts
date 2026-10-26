import { defineConfig } from 'vitest/config';

// Performance measurements on synthetic data; run on demand (pnpm bench), never in CI.
export default defineConfig({
  test: {
    root: './',
    include: ['test/bench/*.bench-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
