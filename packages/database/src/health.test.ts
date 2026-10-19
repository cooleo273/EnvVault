import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDatabaseHealth } from './health.js';

type QueryRaw = Parameters<typeof checkDatabaseHealth>[0]['$queryRaw'];

function fakeClient(responses: (() => Promise<unknown>)[]) {
  let call = 0;
  const $queryRaw = vi.fn(() => {
    const respond = responses[call++] ?? (() => Promise.resolve([]));
    return respond();
  });
  return { $queryRaw: $queryRaw as unknown as QueryRaw };
}

describe('checkDatabaseHealth (unit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is up when connectivity and migrations are fine', async () => {
    const client = fakeClient([
      () => Promise.resolve([1]),
      () => Promise.resolve([{ incomplete: 0 }]),
    ]);
    await expect(checkDatabaseHealth(client)).resolves.toMatchObject({ status: 'up' });
  });

  it('times out hung connections', async () => {
    vi.useFakeTimers();
    const client = fakeClient([() => new Promise(() => undefined)]);
    const pending = checkDatabaseHealth(client, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ status: 'down', reason: 'timeout' });
  });

  it('reports a never-migrated database', async () => {
    const client = fakeClient([
      () => Promise.resolve([1]),
      () => Promise.reject(new Error('relation "_prisma_migrations" does not exist')),
    ]);
    await expect(checkDatabaseHealth(client)).resolves.toMatchObject({
      status: 'down',
      reason: 'migrations_missing',
    });
  });
});
