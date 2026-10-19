import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSync = vi.fn();
const executeRaw = vi.fn();

vi.mock('node:child_process', () => ({ execSync }));
vi.mock('./client.js', () => ({
  createPrismaClient: () => ({ $executeRawUnsafe: executeRaw, $disconnect: vi.fn() }),
}));

const { resetTestDatabase } = await import('./testing.js');

const DISPOSABLE = 'postgresql://u:p@127.0.0.1:5432/envvault_test';

describe('resetTestDatabase', () => {
  const saved = { DIRECT_URL: process.env.DIRECT_URL, DATABASE_URL: process.env.DATABASE_URL };

  beforeEach(() => {
    // A developer's real database, e.g. loaded from the root .env.
    process.env.DIRECT_URL = 'postgresql://u:p@real.example/neondb';
    process.env.DATABASE_URL = 'postgresql://u:p@real-pooler.example/neondb';
    execSync.mockReset();
    executeRaw.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('runs migrations only against the disposable database', async () => {
    await resetTestDatabase(DISPOSABLE);
    expect(execSync).toHaveBeenCalledOnce();
    const options = execSync.mock.calls[0]?.[1] as { env: NodeJS.ProcessEnv };
    expect(options.env.DIRECT_URL).toBe(DISPOSABLE);
    expect(options.env.DATABASE_URL).toBe(DISPOSABLE);
  });

  it('refuses databases whose name does not contain "test"', async () => {
    await expect(resetTestDatabase('postgresql://u:p@real.example/neondb')).rejects.toThrow(
      /must contain "test"/,
    );
    await expect(resetTestDatabase(undefined)).rejects.toThrow(/TEST_DATABASE_URL/);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });
});
