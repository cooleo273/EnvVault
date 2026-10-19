import { defineConfig } from 'vitest/config';

// Unit tests only; database-backed tests live in vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
