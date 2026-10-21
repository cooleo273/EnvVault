import { defineConfig } from 'vitest/config';

// Disaster recovery drill on disposable local databases; run on demand (pnpm drill).
export default defineConfig({
  test: {
    root: './',
    include: ['test/drill/*.drill-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
