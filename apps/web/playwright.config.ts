import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Runs against the production build (`pnpm build` must have run first).
    command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    // Production mode refuses local/http auth URLs, so these are unreachable
    // https placeholders: the suite only covers anonymous behavior (route
    // protection, auth pages, headers). Signed-in flows: playwright.auth.config.ts.
    env: {
      NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
      NEON_AUTH_COOKIE_SECRET: 'e2e-only-cookie-secret-0123456789abcdef',
      APP_BASE_URL: 'https://envvault.example.invalid',
      // A closed port, so results never depend on an API a developer has running locally.
      API_INTERNAL_URL: 'http://127.0.0.1:9',
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
