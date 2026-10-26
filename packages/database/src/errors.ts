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

/** Log safe description of a database error. */
export interface DatabaseErrorSummary {
  type: string;
  code?: string;
  model?: string;
  sqlState?: string;
  constraint?: string;
  column?: string;
}

const IDENTIFIER = /^[A-Za-z0-9_.]{1,128}$/;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

/**
 * Describes a Prisma or driver error without its message. Prisma messages can
 * quote query arguments (ciphertext, wrapped keys, names, emails) and
 * PostgreSQL details can quote row values, so only codes and identifiers
 * survive. Returns null for errors that are not database errors.
 */
export function summarizeDatabaseError(error: unknown): DatabaseErrorSummary | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const cause = driverCause(error) as (DriverAdapterCause & { column?: unknown }) | undefined;
    const meta = error.meta as { modelName?: unknown } | undefined;
    const summary: DatabaseErrorSummary = { type: error.name, code: error.code };
    const model = identifier(meta?.modelName);
    const sqlState = identifier(cause?.originalCode);
    const constraint = getConstraintViolation(error)?.constraint;
    const column = identifier(cause?.column);
    if (model) summary.model = model;
    if (sqlState) summary.sqlState = sqlState;
    if (constraint && IDENTIFIER.test(constraint)) summary.constraint = constraint;
    if (column) summary.column = column;
    return summary;
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      type: error.name,
      ...(identifier(error.errorCode) ? { code: error.errorCode } : {}),
    };
  }
  if (
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return { type: error.name };
  }
  if (error instanceof Error && error.name === 'DriverAdapterError') {
    return { type: error.name };
  }
  return null;
}
