import { describe, expect, it } from 'vitest';
import { createPrismaClient } from './client.js';

describe('createPrismaClient', () => {
  it('requires a connection string', () => {
    expect(() => createPrismaClient({ connectionString: '' })).toThrow(/connection string/);
  });

  it('creates a lazily-connecting client without contacting the database', async () => {
    // Port 1 is unreachable: construction and disconnect must not open a connection.
    const client = createPrismaClient({
      connectionString: 'postgresql://user:password@127.0.0.1:1/unreachable',
    });
    expect(typeof client.$queryRaw).toBe('function');
    await expect(client.$disconnect()).resolves.toBeUndefined();
  });

  it('surfaces connection failures on first query', async () => {
    const client = createPrismaClient({
      connectionString: 'postgresql://user:password@127.0.0.1:1/unreachable',
    });
    await expect(client.$queryRaw`SELECT 1`).rejects.toThrow();
    await client.$disconnect();
  });
});
