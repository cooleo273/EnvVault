import { resetTestDatabase } from '../../src/testing.js';

/** Migrates the disposable TEST_DATABASE_URL database before the suite. */
export default async function setup(): Promise<void> {
  await resetTestDatabase(process.env.TEST_DATABASE_URL);
}
