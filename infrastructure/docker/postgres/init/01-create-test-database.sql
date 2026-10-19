-- Runs once, when the local PostgreSQL volume is first initialised.
-- Creates a disposable database for `pnpm test:integration` (TEST_DATABASE_URL).
-- The integration test setup only ever resets databases whose name contains "test".
CREATE DATABASE envvault_test;

-- Disposable database for the full-stack auth suite (`pnpm test:e2e:auth`, E2E_DATABASE_URL).
CREATE DATABASE envvault_e2e_test;
