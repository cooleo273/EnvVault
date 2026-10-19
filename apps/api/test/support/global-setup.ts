import { existsSync } from 'node:fs';
import { resetTestDatabase } from '@envvault/database/testing';

// Local convenience: TEST_DATABASE_URL may come from the root .env.
const rootEnvFile = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

export default async function setup(): Promise<void> {
  await resetTestDatabase(process.env.TEST_DATABASE_URL);
}
