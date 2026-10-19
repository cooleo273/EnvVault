import { describe, expect, it } from 'vitest';
import { getConstraintViolation } from './errors.js';
import { Prisma } from './generated/prisma/client.js';

function adapterError(code: string, cause: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('db error', {
    code,
    clientVersion: 'test',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

describe('getConstraintViolation', () => {
  it('classifies unique violations using the reported index', () => {
    const error = adapterError('P2002', {
      originalCode: '23505',
      originalMessage:
        'duplicate key value violates unique constraint "secrets_environment_key_live_key"',
      constraint: { index: 'secrets_environment_key_live_key' },
    });
    expect(getConstraintViolation(error)).toEqual({
      kind: 'unique',
      constraint: 'secrets_environment_key_live_key',
    });
  });

  it('classifies foreign key and check violations from the SQLSTATE', () => {
    expect(
      getConstraintViolation(
        adapterError('P2003', {
          originalCode: '23503',
          originalMessage:
            'insert or update on table "secrets" violates foreign key constraint "secrets_environment_fkey"',
        }),
      ),
    ).toEqual({ kind: 'foreign_key', constraint: 'secrets_environment_fkey' });

    expect(
      getConstraintViolation(
        adapterError('P2039', {
          originalCode: '23514',
          originalMessage:
            'new row for relation "secrets" violates check constraint "secrets_key_format_chk"',
        }),
      ),
    ).toEqual({ kind: 'check', constraint: 'secrets_key_format_chk' });
  });

  it('treats integrity-trigger errors as check violations without a constraint name', () => {
    expect(
      getConstraintViolation(
        adapterError('P2039', {
          originalCode: '23514',
          originalMessage: 'audit_events is append-only (UPDATE rejected)',
        }),
      ),
    ).toEqual({ kind: 'check', constraint: undefined });
  });

  it('falls back to Prisma codes and ignores unrelated errors', () => {
    expect(getConstraintViolation(adapterError('P2002', {}))).toEqual({
      kind: 'unique',
      constraint: undefined,
    });
    expect(getConstraintViolation(adapterError('P2025', {}))).toBeNull();
    expect(getConstraintViolation(new Error('boom'))).toBeNull();
  });
});
