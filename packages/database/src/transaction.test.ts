import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { isRetryableTransactionError, withTransaction } from './transaction.js';

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: 'test' });
}

function fakeClient(impl: (attempt: number) => Promise<unknown>) {
  let attempt = 0;
  const $transaction = vi.fn(() => impl(attempt++));
  return {
    client: { $transaction } as unknown as Pick<PrismaClient, '$transaction'>,
    $transaction,
  };
}

describe('withTransaction', () => {
  it('passes isolation level and timeouts to Prisma', async () => {
    const { client, $transaction } = fakeClient(() => Promise.resolve('ok'));
    await expect(
      withTransaction(client, () => Promise.resolve('ignored'), {
        isolationLevel: 'Serializable',
        timeoutMs: 1_000,
        maxWaitMs: 500,
      }),
    ).resolves.toBe('ok');
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 1_000,
      maxWait: 500,
    });
  });

  it('defaults to READ COMMITTED', async () => {
    const { client, $transaction } = fakeClient(() => Promise.resolve(1));
    await withTransaction(client, () => Promise.resolve(1));
    expect($transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'ReadCommitted' }),
    );
  });

  it('retries serialization conflicts up to maxRetries', async () => {
    const { client, $transaction } = fakeClient((attempt) =>
      attempt < 2 ? Promise.reject(knownError('P2034')) : Promise.resolve('committed'),
    );
    await expect(withTransaction(client, () => Promise.resolve(null))).resolves.toBe('committed');
    expect($transaction).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries', async () => {
    const { client, $transaction } = fakeClient(() => Promise.reject(knownError('P2034')));
    await expect(
      withTransaction(client, () => Promise.resolve(null), { maxRetries: 1 }),
    ).rejects.toThrow('conflict');
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    const { client, $transaction } = fakeClient(() => Promise.reject(knownError('P2002')));
    await expect(withTransaction(client, () => Promise.resolve(null))).rejects.toThrow();
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(isRetryableTransactionError(new Error('P2034'))).toBe(false);
  });
});
