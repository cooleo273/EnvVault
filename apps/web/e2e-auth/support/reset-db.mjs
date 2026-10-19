// Migrates the disposable E2E database. Runs as part of the API web server's
// command so the schema exists before the API opens its connection pool
// (Playwright starts web servers before globalSetup).
import { resetTestDatabase } from '../../../../packages/database/dist/testing.js';

await resetTestDatabase(process.env.DATABASE_URL);
