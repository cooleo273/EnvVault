import type { DbClient } from '../client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SecretType, ValueFormat } from '../generated/prisma/enums.js';
import type { EnvironmentScope } from '../scope.js';

type UserRef = { displayName: string | null; email: string } | null;
const userRef = { select: { displayName: true, email: true } } as const;

function scopeWhere(scope: EnvironmentScope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

/* ------------------------------------------------------------ Validation rules */

export interface ValidationRuleData {
  key: string;
  required: boolean;
  allowEmpty: boolean;
  format: ValueFormat;
  minNumber: number | null;
  maxNumber: number | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  allowedValues: string[];
  description: string | null;
}

export interface ValidationRuleRecord extends ValidationRuleData {
  id: string;
  updatedAt: Date;
  updatedBy: UserRef;
}

/** Validation rules of one environment. */
export class ValidationRuleRepository {
  constructor(private readonly db: DbClient) {}

  async list(scope: EnvironmentScope): Promise<ValidationRuleRecord[]> {
    const rows = await this.db.configurationValidationRule.findMany({
      where: scopeWhere(scope),
      orderBy: { key: 'asc' },
      include: { updatedByUser: userRef },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      required: row.required,
      allowEmpty: row.allowEmpty,
      format: row.format,
      minNumber: row.minNumber === null ? null : row.minNumber.toNumber(),
      maxNumber: row.maxNumber === null ? null : row.maxNumber.toNumber(),
      minLength: row.minLength,
      maxLength: row.maxLength,
      pattern: row.pattern,
      allowedValues: row.allowedValues,
      description: row.description,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedByUser,
    }));
  }

  /** Replaces the environment's whole rule set. Run in a transaction. */
  async replace(
    scope: EnvironmentScope,
    rules: readonly ValidationRuleData[],
    userId: string,
  ): Promise<void> {
    await this.db.configurationValidationRule.deleteMany({ where: scopeWhere(scope) });
    if (rules.length === 0) return;
    await this.db.configurationValidationRule.createMany({
      data: rules.map((rule) => ({
        ...scopeWhere(scope),
        ...rule,
        minNumber: rule.minNumber === null ? null : new Prisma.Decimal(rule.minNumber),
        maxNumber: rule.maxNumber === null ? null : new Prisma.Decimal(rule.maxNumber),
        createdByUserId: userId,
        updatedByUserId: userId,
      })),
    });
  }
}

/* ------------------------------------------------------------------ Snapshots */

/** Metadata of one variable as captured by a snapshot. */
export interface SnapshotEntryData {
  secretId: string;
  secretVersionId: string | null;
  versionNumber: number | null;
  key: string;
  type: SecretType;
  category: string | null;
  tags: string[];
  isRequired: boolean;
  inheritable: boolean;
  description: string | null;
}

export interface SnapshotRecord {
  id: string;
  environmentId: string;
  description: string | null;
  status: 'COMPLETE';
  schemaVersion: number;
  entryCount: number;
  baseEnvironmentId: string | null;
  createdAt: Date;
  createdBy: UserRef;
}

const snapshotSelect = {
  id: true,
  environmentId: true,
  description: true,
  status: true,
  schemaVersion: true,
  entryCount: true,
  baseEnvironmentId: true,
  createdAt: true,
  createdByUser: userRef,
} as const satisfies Prisma.EnvironmentSnapshotSelect;

function toSnapshot(
  row: Prisma.EnvironmentSnapshotGetPayload<{ select: typeof snapshotSelect }>,
): SnapshotRecord {
  const { createdByUser, ...rest } = row;
  return { ...rest, createdBy: createdByUser };
}

/**
 * Immutable environment snapshots. Entries reference exact secret versions;
 * the composite foreign keys guarantee each secret belongs to the snapshot's
 * environment and each version to its secret.
 */
export class SnapshotRepository {
  constructor(private readonly db: DbClient) {}

  /** Writes a snapshot and its entries (two statements). Run in a transaction. */
  async create(
    scope: EnvironmentScope,
    data: {
      id: string;
      description: string | null;
      baseEnvironmentId: string | null;
      entries: readonly SnapshotEntryData[];
    },
    userId: string,
  ): Promise<SnapshotRecord> {
    const row = await this.db.environmentSnapshot.create({
      data: {
        id: data.id,
        ...scopeWhere(scope),
        description: data.description,
        baseEnvironmentId: data.baseEnvironmentId,
        entryCount: data.entries.length,
        createdByUserId: userId,
      },
      select: snapshotSelect,
    });
    if (data.entries.length > 0) {
      await this.db.environmentSnapshotEntry.createMany({
        data: data.entries.map((entry) => ({
          workspaceId: scope.workspaceId,
          snapshotId: data.id,
          environmentId: scope.environmentId,
          ...entry,
        })),
      });
    }
    return toSnapshot(row);
  }

  /**
   * Captures every live variable of the environment with one INSERT ... SELECT.
   * Run in the same REPEATABLE READ transaction that counted them: the copy
   * then sees exactly those rows. Row by row inserts from the application
   * cost about ten times as much for 2000 variables.
   */
  async captureLive(
    scope: EnvironmentScope,
    data: {
      id: string;
      description: string | null;
      baseEnvironmentId: string | null;
      expected: number;
    },
    userId: string,
  ): Promise<SnapshotRecord> {
    const row = await this.db.environmentSnapshot.create({
      data: {
        id: data.id,
        ...scopeWhere(scope),
        description: data.description,
        baseEnvironmentId: data.baseEnvironmentId,
        entryCount: data.expected,
        createdByUserId: userId,
      },
      select: snapshotSelect,
    });
    const inserted = await this.db.$executeRaw`
      INSERT INTO "environment_snapshot_entries" (
        "id", "workspace_id", "snapshot_id", "environment_id", "secret_id", "secret_version_id",
        "version_number", "key", "type", "category", "tags", "is_required", "inheritable", "description"
      )
      SELECT gen_random_uuid(), s."workspace_id", ${data.id}::uuid, s."environment_id", s."id",
             s."current_version_id", v."version_number", s."key", s."type", s."category", s."tags",
             s."is_required", s."inheritable", s."description"
      FROM "secrets" s
      LEFT JOIN "secret_versions" v ON v."secret_id" = s."id" AND v."id" = s."current_version_id"
      WHERE s."workspace_id" = ${scope.workspaceId}::uuid AND s."project_id" = ${scope.projectId}::uuid
        AND s."environment_id" = ${scope.environmentId}::uuid AND s."deleted_at" IS NULL`;
    if (inserted !== data.expected) {
      throw new Error('Snapshot capture did not match the counted variables');
    }
    return toSnapshot(row);
  }

  async list(
    scope: EnvironmentScope,
    page: { skip: number; take: number },
  ): Promise<{ items: SnapshotRecord[]; total: number }> {
    const where = scopeWhere(scope);
    const [rows, total] = await Promise.all([
      this.db.environmentSnapshot.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.take,
        select: snapshotSelect,
      }),
      this.db.environmentSnapshot.count({ where }),
    ]);
    return { items: rows.map(toSnapshot), total };
  }

  async get(scope: EnvironmentScope, snapshotId: string): Promise<SnapshotRecord | null> {
    const row = await this.db.environmentSnapshot.findFirst({
      where: { id: snapshotId, ...scopeWhere(scope) },
      select: snapshotSelect,
    });
    return row ? toSnapshot(row) : null;
  }

  /** Entries in name order. Empty for a snapshot outside the scope. */
  async entries(scope: EnvironmentScope, snapshotId: string): Promise<SnapshotEntryData[]> {
    return this.db.environmentSnapshotEntry.findMany({
      where: { snapshotId, workspaceId: scope.workspaceId, environmentId: scope.environmentId },
      orderBy: { key: 'asc' },
      select: {
        secretId: true,
        secretVersionId: true,
        versionNumber: true,
        key: true,
        type: true,
        category: true,
        tags: true,
        isRequired: true,
        inheritable: true,
        description: true,
      },
    });
  }
}
