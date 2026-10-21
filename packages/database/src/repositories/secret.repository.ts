import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SecretType, SecretVersionOrigin } from '../generated/prisma/enums.js';
import type { EnvironmentScope, WorkspaceScope } from '../scope.js';

type UserRef = { displayName: string | null; email: string } | null;

const userRef = { select: { displayName: true, email: true } } as const;

/** Metadata of one variable. Never contains a value or ciphertext. */
export interface SecretRecord {
  id: string;
  environmentId: string;
  key: string;
  description: string | null;
  type: SecretType;
  category: string | null;
  tags: string[];
  isRequired: boolean;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  createdBy: UserRef;
  updatedBy: UserRef;
  deletedBy: UserRef;
}

/** Encrypted columns of one version plus the key reference needed to decrypt it. */
export interface StoredSecretVersion {
  versionId: string;
  versionNumber: number;
  envelopeVersion: number;
  /** Database enum value; checked again before decryption. */
  algorithm: string;
  kmsProvider: string;
  kmsKeyRef: string;
  kmsKeyVersion: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
}

/** A version to insert. The id is chosen by the caller because it is bound into the ciphertext. */
export interface NewSecretVersion {
  id: string;
  encryptionKeyId: string;
  kmsKeyVersion: string;
  envelopeVersion: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  encryptedDataKey: Uint8Array;
  origin: SecretVersionOrigin;
  changeReason?: string | null | undefined;
  /** Required for ROLLBACK versions: the restored version of the same secret. */
  restoredFromVersionId?: string | null | undefined;
}

/** Metadata of one version. Never selects encrypted columns. */
export interface SecretVersionRecord {
  id: string;
  versionNumber: number;
  isCurrent: boolean;
  origin: SecretVersionOrigin;
  changeReason: string | null;
  restoredFromVersion: number | null;
  keyVersion: number | null;
  createdAt: Date;
  createdBy: UserRef;
}

export const storedVersionSelect = {
  id: true,
  versionNumber: true,
  envelopeVersion: true,
  algorithm: true,
  kmsKeyVersion: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  encryptedDataKey: true,
  encryptionKey: { select: { kmsProvider: true, kmsKeyRef: true } },
} as const satisfies Prisma.SecretVersionSelect;

type StoredVersionRow = Prisma.SecretVersionGetPayload<{ select: typeof storedVersionSelect }>;

export function toStoredVersion(version: StoredVersionRow): StoredSecretVersion {
  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    envelopeVersion: version.envelopeVersion,
    algorithm: version.algorithm,
    kmsProvider: version.encryptionKey.kmsProvider,
    kmsKeyRef: version.encryptionKey.kmsKeyRef,
    kmsKeyVersion: version.kmsKeyVersion,
    ciphertext: Buffer.from(version.ciphertext),
    iv: Buffer.from(version.iv),
    authTag: Buffer.from(version.authTag),
    encryptedDataKey: Buffer.from(version.encryptedDataKey),
  };
}

const versionMetaSelect = {
  id: true,
  versionNumber: true,
  origin: true,
  changeReason: true,
  kmsKeyVersion: true,
  createdAt: true,
  createdByUser: userRef,
  restoredFrom: { select: { versionNumber: true } },
} as const satisfies Prisma.SecretVersionSelect;

function toVersionRecord(
  row: Prisma.SecretVersionGetPayload<{ select: typeof versionMetaSelect }>,
  currentVersionId: string | null,
): SecretVersionRecord {
  const { createdByUser, restoredFrom, kmsKeyVersion, ...rest } = row;
  return {
    ...rest,
    isCurrent: row.id === currentVersionId,
    restoredFromVersion: restoredFrom?.versionNumber ?? null,
    keyVersion: kmsKeyVersion && /^\d+$/.test(kmsKeyVersion) ? Number(kmsKeyVersion) : null,
    createdBy: createdByUser,
  };
}

/** Insert data for one version row (shared by single and bulk writes). */
export function versionData(
  workspaceId: string,
  secretId: string,
  versionNumber: number,
  version: NewSecretVersion,
  userId: string,
): Prisma.SecretVersionCreateManyInput {
  const reason = version.changeReason?.trim();
  return {
    id: version.id,
    workspaceId,
    secretId,
    versionNumber,
    ciphertext: new Uint8Array(version.ciphertext),
    iv: new Uint8Array(version.iv),
    authTag: new Uint8Array(version.authTag),
    encryptedDataKey: new Uint8Array(version.encryptedDataKey),
    algorithm: 'AES_256_GCM',
    envelopeVersion: version.envelopeVersion,
    encryptionKeyId: version.encryptionKeyId,
    kmsKeyVersion: version.kmsKeyVersion,
    origin: version.origin,
    changeReason: reason === undefined || reason === '' ? null : reason,
    restoredFromVersionId: version.restoredFromVersionId ?? null,
    createdByUserId: userId,
  };
}

export interface SecretMetadataPatch {
  key?: string | undefined;
  description?: string | null | undefined;
  type?: SecretType | undefined;
  category?: string | null | undefined;
  tags?: string[] | undefined;
  isRequired?: boolean | undefined;
}

export interface NewSecretData {
  id: string;
  key: string;
  description: string | null;
  type: SecretType;
  category: string | null;
  tags: string[];
  isRequired: boolean;
}

export type SecretSort = 'name' | 'type' | 'category' | 'created' | 'updated';

export interface SecretListQuery {
  status: 'active' | 'deleted';
  q?: string | undefined;
  types?: SecretType[] | undefined;
  /** `none` selects variables without a category. */
  categories?: string[] | undefined;
  tag?: string | undefined;
  sort: SecretSort;
  order: 'asc' | 'desc';
  skip: number;
  take: number;
}

const recordSelect = {
  id: true,
  environmentId: true,
  key: true,
  description: true,
  type: true,
  category: true,
  tags: true,
  isRequired: true,
  currentVersionId: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  currentVersion: { select: { versionNumber: true } },
  createdByUser: userRef,
  updatedByUser: userRef,
  deletedByUser: userRef,
} as const satisfies Prisma.SecretSelect;

type RecordRow = Prisma.SecretGetPayload<{ select: typeof recordSelect }>;

function toRecord(row: RecordRow): SecretRecord {
  const { currentVersion, createdByUser, updatedByUser, deletedByUser, ...rest } = row;
  return {
    ...rest,
    currentVersionNumber: currentVersion?.versionNumber ?? null,
    createdBy: createdByUser,
    updatedBy: updatedByUser,
    deletedBy: deletedByUser,
  };
}

function scopeWhere(scope: EnvironmentScope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function orderBy(sort: SecretSort, order: 'asc' | 'desc'): Prisma.SecretOrderByWithRelationInput[] {
  const tiebreak: Prisma.SecretOrderByWithRelationInput[] = [{ key: 'asc' }, { id: 'asc' }];
  switch (sort) {
    case 'type':
      return [{ type: order }, ...tiebreak];
    case 'category':
      return [{ category: { sort: order, nulls: 'last' } }, ...tiebreak];
    case 'created':
      return [{ createdAt: order }, { id: order }];
    case 'updated':
      return [{ updatedAt: order }, { id: order }];
    default:
      return [{ key: order }, { id: order }];
  }
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Variables of one environment. Every method is constrained by the
 * environment scope (workspace, project and environment together), so an id
 * from another tenant or environment is simply not found.
 *
 * Concurrency: every mutation increments `revision` and is conditional on the
 * revision the caller read, so concurrent writers cannot silently overwrite
 * each other. Version numbers are allocated by the same row locking UPDATE,
 * and `UNIQUE(secret_id, version_number)` backs that up.
 */
export class SecretRepository {
  constructor(private readonly db: DbClient) {}

  async list(
    scope: EnvironmentScope,
    query: SecretListQuery,
  ): Promise<{ items: SecretRecord[]; total: number }> {
    const q = query.q?.trim();
    const categories = query.categories ?? [];
    const named = categories.filter((c) => c !== 'none');
    const where: Prisma.SecretWhereInput = {
      ...scopeWhere(scope),
      deletedAt: query.status === 'active' ? null : { not: null },
      ...(query.types?.length ? { type: { in: query.types } } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      AND: [
        q
          ? {
              OR: [
                { key: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
        categories.length
          ? {
              OR: [
                ...(named.length ? [{ category: { in: named } }] : []),
                ...(categories.includes('none') ? [{ category: null }] : []),
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.db.secret.findMany({
        where,
        orderBy: orderBy(query.sort, query.order),
        skip: query.skip,
        take: query.take,
        select: recordSelect,
      }),
      this.db.secret.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }

  /** Categories and tags used by live variables of the environment, sorted. */
  async facets(scope: EnvironmentScope): Promise<{ categories: string[]; tags: string[] }> {
    const [categoryRows, tagRows] = await Promise.all([
      this.db.secret.findMany({
        where: { ...scopeWhere(scope), deletedAt: null, category: { not: null } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
        take: 200,
      }),
      this.db.$queryRaw<{ tag: string }[]>`
        SELECT DISTINCT unnest("tags") AS "tag" FROM "secrets"
        WHERE "workspace_id" = ${scope.workspaceId}::uuid
          AND "project_id" = ${scope.projectId}::uuid
          AND "environment_id" = ${scope.environmentId}::uuid
          AND "deleted_at" IS NULL
        ORDER BY 1 LIMIT 200`,
    ]);
    return {
      categories: categoryRows.flatMap((r) => (r.category ? [r.category] : [])),
      tags: tagRows.map((r) => r.tag),
    };
  }

  async get(scope: EnvironmentScope, secretId: string): Promise<SecretRecord | null> {
    const row = await this.db.secret.findFirst({
      where: { id: secretId, ...scopeWhere(scope) },
      select: recordSelect,
    });
    return row ? toRecord(row) : null;
  }

  /** True if a live variable in the environment already uses `key` (case sensitive). */
  async isKeyTaken(scope: EnvironmentScope, key: string, exceptId?: string): Promise<boolean> {
    const found = await this.db.secret.findFirst({
      where: {
        ...scopeWhere(scope),
        key,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Inserts the metadata and, when given, its first version in one statement
   * sequence. Call inside a transaction: the current version reference is a
   * deferred foreign key that is checked at commit.
   */
  async create(
    scope: EnvironmentScope,
    data: NewSecretData,
    version: NewSecretVersion | null,
    userId: string,
  ): Promise<{ id: string; revision: number }> {
    const created = await this.db.secret.create({
      data: {
        id: data.id,
        ...scopeWhere(scope),
        key: data.key,
        description: emptyToNull(data.description) ?? null,
        type: data.type,
        category: data.category,
        tags: data.tags,
        isRequired: data.isRequired,
        latestVersionNumber: version ? 1 : 0,
        currentVersionId: version?.id ?? null,
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      select: { id: true, revision: true },
    });
    if (version) await this.insertVersion(scope, data.id, 1, version, userId);
    return created;
  }

  /**
   * Applies a metadata patch and, optionally, a new value version, if the
   * variable is live and still at `expectedRevision`. Returns null otherwise
   * (the caller distinguishes a conflict from a missing variable). Must run
   * inside a transaction when `version` is given.
   */
  async update(
    scope: EnvironmentScope,
    secretId: string,
    expectedRevision: number,
    patch: SecretMetadataPatch,
    version: NewSecretVersion | null,
    userId: string,
  ): Promise<{ revision: number; versionNumber: number | null } | null> {
    const description = emptyToNull(patch.description);
    const result = await this.db.secret.updateMany({
      where: { id: secretId, ...scopeWhere(scope), deletedAt: null, revision: expectedRevision },
      data: {
        ...(patch.key === undefined ? {} : { key: patch.key }),
        ...(description === undefined ? {} : { description }),
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.isRequired === undefined ? {} : { isRequired: patch.isRequired }),
        ...(version ? { latestVersionNumber: { increment: 1 } } : {}),
        revision: { increment: 1 },
        updatedByUserId: userId,
      },
    });
    if (result.count !== 1) return null;
    // The UPDATE above holds the row lock, so this read sees our own allocation.
    const row = await this.db.secret.findFirstOrThrow({
      where: { id: secretId, ...scopeWhere(scope) },
      select: { revision: true, latestVersionNumber: true },
    });
    if (!version) return { revision: row.revision, versionNumber: null };
    await this.insertVersion(scope, secretId, row.latestVersionNumber, version, userId);
    await this.db.secret.updateMany({
      where: { id: secretId, ...scopeWhere(scope) },
      data: { currentVersionId: version.id },
    });
    return { revision: row.revision, versionNumber: row.latestVersionNumber };
  }

  /** Soft delete. Versions stay untouched so the variable can be restored. */
  async softDelete(
    scope: EnvironmentScope,
    secretId: string,
    userId: string,
    expectedRevision?: number,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.db.secret.updateMany({
      where: {
        id: secretId,
        ...scopeWhere(scope),
        deletedAt: null,
        ...(expectedRevision === undefined ? {} : { revision: expectedRevision }),
      },
      data: {
        deletedAt: now,
        deletedByUserId: userId,
        revision: { increment: 1 },
        updatedByUserId: userId,
      },
    });
    return result.count === 1;
  }

  /**
   * Clears the deletion. A live variable with the same name makes the
   * partial unique index reject this (`secrets_environment_key_live_key`).
   */
  async restore(scope: EnvironmentScope, secretId: string, userId: string): Promise<boolean> {
    const result = await this.db.secret.updateMany({
      where: { id: secretId, ...scopeWhere(scope), deletedAt: { not: null } },
      data: {
        deletedAt: null,
        deletedByUserId: null,
        revision: { increment: 1 },
        updatedByUserId: userId,
      },
    });
    return result.count === 1;
  }

  /** The current version's encrypted columns and key reference, or null without a value. */
  async currentVersion(
    scope: EnvironmentScope,
    secretId: string,
  ): Promise<StoredSecretVersion | null> {
    const row = await this.db.secret.findFirst({
      where: { id: secretId, ...scopeWhere(scope), deletedAt: null },
      select: { currentVersion: { select: storedVersionSelect } },
    });
    return row?.currentVersion ? toStoredVersion(row.currentVersion) : null;
  }

  /**
   * One historical version's encrypted columns, if it belongs to this secret
   * in this environment. Deleted variables are excluded.
   */
  async version(
    scope: EnvironmentScope,
    secretId: string,
    versionId: string,
  ): Promise<StoredSecretVersion | null> {
    const row = await this.db.secretVersion.findFirst({
      where: {
        id: versionId,
        secretId,
        workspaceId: scope.workspaceId,
        secret: { ...scopeWhere(scope), deletedAt: null },
      },
      select: storedVersionSelect,
    });
    return row ? toStoredVersion(row) : null;
  }

  /**
   * Version metadata, newest first, with keyset pagination on the version
   * number (`before`). Never selects encrypted columns.
   */
  async listVersions(
    scope: EnvironmentScope,
    secretId: string,
    options: { before?: number | undefined; limit: number } = { limit: 100 },
  ): Promise<{ items: SecretVersionRecord[]; total: number; nextBefore: number | null }> {
    const secret = await this.db.secret.findFirst({
      where: { id: secretId, ...scopeWhere(scope) },
      select: { currentVersionId: true },
    });
    if (!secret) return { items: [], total: 0, nextBefore: null };
    const where = { secretId, workspaceId: scope.workspaceId };
    const [rows, total] = await Promise.all([
      this.db.secretVersion.findMany({
        where: {
          ...where,
          ...(options.before === undefined ? {} : { versionNumber: { lt: options.before } }),
        },
        orderBy: { versionNumber: 'desc' },
        take: options.limit + 1,
        select: versionMetaSelect,
      }),
      this.db.secretVersion.count({ where }),
    ]);
    const page = rows.slice(0, options.limit);
    return {
      items: page.map((row) => toVersionRecord(row, secret.currentVersionId)),
      total,
      nextBefore: rows.length > options.limit ? (page.at(-1)?.versionNumber ?? null) : null,
    };
  }

  /** Metadata of specific versions of one secret in this environment. */
  async versionDetails(
    scope: EnvironmentScope,
    secretId: string,
    versionIds: readonly string[],
  ): Promise<SecretVersionRecord[]> {
    const secret = await this.db.secret.findFirst({
      where: { id: secretId, ...scopeWhere(scope) },
      select: { currentVersionId: true },
    });
    if (!secret) return [];
    const rows = await this.db.secretVersion.findMany({
      where: { secretId, workspaceId: scope.workspaceId, id: { in: [...versionIds] } },
      select: versionMetaSelect,
    });
    return rows.map((row) => toVersionRecord(row, secret.currentVersionId));
  }

  /** Live variables in the environment (for the expected key overview). */
  countLive(scope: EnvironmentScope): Promise<number> {
    return this.db.secret.count({ where: { ...scopeWhere(scope), deletedAt: null } });
  }

  private async insertVersion(
    scope: EnvironmentScope,
    secretId: string,
    versionNumber: number,
    version: NewSecretVersion,
    userId: string,
  ): Promise<void> {
    await this.db.secretVersion.create({
      data: versionData(scope.workspaceId, secretId, versionNumber, version, userId),
      select: { id: true },
    });
  }
}

/**
 * Per workspace bookkeeping of the key encryption key that wraps new data
 * keys. Rows hold provider identifiers only, never key material.
 */
export class EncryptionKeyRepository {
  constructor(private readonly db: DbClient) {}

  find(
    scope: WorkspaceScope,
    kmsProvider: string,
    kmsKeyRef: string,
  ): Promise<{ id: string } | null> {
    return this.db.encryptionKey.findFirst({
      where: { workspaceId: scope.workspaceId, kmsProvider, kmsKeyRef },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
  }

  /**
   * Returns the row for a provider key, registering it as the workspace's
   * ACTIVE key when it is new (the previous ACTIVE row becomes DECRYPT_ONLY).
   * Run in a transaction: a per workspace advisory lock serialises concurrent
   * registrations, so every caller gets the same row.
   */
  async ensureActive(
    scope: WorkspaceScope,
    kmsProvider: string,
    kmsKeyRef: string,
  ): Promise<{ id: string }> {
    await this.db.$queryRaw`
      SELECT 1 AS "locked" FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${`encryption-keys:${scope.workspaceId}`}, 0))
      ) AS "lock"`;
    const existing = await this.find(scope, kmsProvider, kmsKeyRef);
    if (existing) return existing;
    await this.db.encryptionKey.updateMany({
      where: { workspaceId: scope.workspaceId, status: 'ACTIVE' },
      data: { status: 'DECRYPT_ONLY' },
    });
    const latest = await this.db.encryptionKey.aggregate({
      where: { workspaceId: scope.workspaceId },
      _max: { version: true },
    });
    return this.db.encryptionKey.create({
      data: {
        workspaceId: scope.workspaceId,
        version: (latest._max.version ?? 0) + 1,
        kmsProvider,
        kmsKeyRef,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  }
}
