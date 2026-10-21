import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

/**
 * Full-stack end-to-end tests: browser → Next.js (official Neon Auth SDK)
 * → Neon Auth stand-in (real Better Auth, configured like Neon) and
 * → EnvVault API (verifies Neon-style JWTs, authorizes against PostgreSQL).
 *
 * Requires E2E_DATABASE_URL pointing at a disposable database whose name
 * contains "test". e2e-auth/support/reset-db.mjs resets it before the API
 * starts. Uses `next dev` because production builds correctly refuse
 * non-https auth URLs.
 */
const WEB_PORT = 3200;
const API_PORT = 4100;
const STANDIN_PORT = 4410;

const webOrigin = `http://localhost:${String(WEB_PORT)}`;
const authBaseUrl = `http://localhost:${String(STANDIN_PORT)}/neondb/auth`;
const databaseUrl = process.env.E2E_DATABASE_URL ?? '';

/**
 * Throwaway development keyring (format of @envvault/crypto's local
 * provider) so the API encrypts real values during the run. It exists only in
 * this process's environment and protects synthetic test values only.
 */
const e2eKeyring = Buffer.from(
  JSON.stringify({
    format: 'envvault.local-keyring',
    formatVersion: 1,
    usage: 'development',
    keyId: `local-${randomBytes(16).toString('hex')}`,
    activeVersion: 1,
    versions: [
      {
        version: 1,
        status: 'active',
        createdAt: new Date().toISOString(),
        key: randomBytes(32).toString('base64'),
      },
    ],
  }),
).toString('base64');

export default defineConfig({
  testDir: './e2e-auth',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  // next dev compiles each route on first visit; allow for it in assertions.
  expect: { timeout: 15_000 },
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'auth-flows',
      testMatch: /(auth-flows|collaboration|secrets|secret-transfers)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testMatch: /(app-shell|workspaces|projects)\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e-auth/.auth/user.json' },
    },
  ],
  webServer: [
    {
      command: 'node e2e/support/neon-auth-standin.mjs',
      url: `http://localhost:${String(STANDIN_PORT)}/__test/health`,
      env: { STANDIN_PORT: String(STANDIN_PORT), STANDIN_TRUSTED_ORIGINS: webOrigin },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node ../web/e2e-auth/support/reset-db.mjs && node dist/main.js',
      cwd: '../api',
      stdout: 'pipe',
      url: `http://localhost:${String(API_PORT)}/api/v1/health`,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        API_HOST: 'localhost',
        API_PORT: String(API_PORT),
        DATABASE_URL: databaseUrl,
        CORS_ORIGINS: webOrigin,
        NEON_AUTH_BASE_URL: authBaseUrl,
        AUTH_TRUSTED_ORIGIN: webOrigin,
        RATE_LIMIT_MAX: '10000',
        ENCRYPTION_PROVIDER: 'local',
        ENCRYPTION_LOCAL_KEYRING: e2eKeyring,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next dev --port ${String(WEB_PORT)}`,
      url: webOrigin,
      env: {
        NEON_AUTH_BASE_URL: authBaseUrl,
        // Test-only value; real environments use `openssl rand -base64 32`.
        NEON_AUTH_COOKIE_SECRET: 'e2e-only-cookie-secret-0123456789abcdef',
        APP_BASE_URL: webOrigin,
        API_INTERNAL_URL: `http://localhost:${String(API_PORT)}`,
        NEXT_PUBLIC_API_URL: `http://localhost:${String(API_PORT)}`,
        // Own build dir so a developer's `pnpm dev` can keep running.
        NEXT_DIST_DIR: '.next-e2e',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
