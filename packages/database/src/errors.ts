import { Prisma } from './generated/prisma/client.js';

export type ConstraintViolationKind = 'unique' | 'foreign_key' | 'check';

export interface ConstraintViolation {
  kind: ConstraintViolationKind;
  /** Constraint/index name when available (e.g. `secrets_environment_key_live_key`). */
  constraint: string | undefined;
}

const SQLSTATE_KINDS: Record<string, ConstraintViolationKind> = {
  '23505': 'unique',
  '23503': 'foreign_key',
  // CHECK constraints and EnvVault's integrity triggers (which raise 23514).
  '23514': 'check',
};

/** Fallback when the driver adapter did not report a SQLSTATE. */
const PRISMA_CODE_KINDS: Record<string, ConstraintViolationKind> = {
  P2002: 'unique',
  P2003: 'foreign_key',
};

interface DriverAdapterCause {
  originalCode?: unknown;
  originalMessage?: unknown;
  constraint?: { index?: unknown };
}

function driverCause(error: Prisma.PrismaClientKnownRequestError): DriverAdapterCause | undefined {
  const meta = error.meta as { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined;
  return meta?.driverAdapterError?.cause;
}

/**
 * Classifies database constraint violations so callers can map them to
 * domain errors (e.g. 409 Conflict). Returns only the violation kind and
 * constraint name: PostgreSQL error details can include row values and must
 * never be returned to clients or logged verbatim.
 */
export function getConstraintViolation(error: unknown): ConstraintViolation | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const cause = driverCause(error);
  const sqlState = typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
  const kind =
    (sqlState === undefined ? undefined : SQLSTATE_KINDS[sqlState]) ??
    PRISMA_CODE_KINDS[error.code];
  if (kind === undefined) {
    return null;
  }

  let constraint: string | undefined;
  if (typeof cause?.constraint?.index === 'string') {
    constraint = cause.constraint.index;
  } else if (typeof cause?.originalMessage === 'string') {
    constraint = /constraint "([^"]+)"/.exec(cause.originalMessage)?.[1];
  }
  return { kind, constraint };
}
