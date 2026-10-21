import type { DbClient } from '../client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SecretType } from '../generated/prisma/enums.js';
import type { EnvironmentScope } from '../scope.js';
import {
  type NewSecretData,
  type NewSecretVersion,
  type StoredSecretVersion,
  storedVersionSelect,
  toStoredVersion,
  versionData,
} from './secret.repository.js';

export interface SecretFilters {
  status: 'active' | 'deleted';
  q?: string | undefined;
  types?: SecretType[] | undefined;
  categories?: string[] | undefined;
  tag?: string | undefined;
}

/** Live variable state used to plan imports and bulk changes. */
export interface SecretState {
  id: string;
  key: string;
  type: SecretType;
  revision: number;
  hasValue: boolean;
  deleted: boolean;
}

export interface ValueOverwrite {
  secretId: string;
  expectedRevision: number;
  version: NewSecretVersion;
}

export interface BulkPatch {
  category?: string | null | undefined;
  addTags?: string[] | undefined;
  removeTags?: string[] | undefined;
  isRequired?: boolean | undefined;
}

function scopeWhere(scope: EnvironmentScope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function filterWhere(scope: EnvironmentScope, filters: SecretFilters): Prisma.SecretWhereInput {
  const q = filters.q?.trim();
  const categories = filters.categories ?? [];
  const named = categories.filter((c) => c !== 'none');
  return {
    ...scopeWhere(scope),
    deletedAt: filters.status === 'active' ? null : { not: null },
    ...(filters.types?.length ? { type: { in: filters.types } } : {}),
    ...(filters.tag ? { tags: { has: filters.tag } } : {}),
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
}

const stateSelect = {
  id: true,
  key: true,
  type: true,
  revision: true,
  currentVersionId: true,
  deletedAt: true,
} as const satisfies Prisma.SecretSelect;

function toState(row: Prisma.SecretGetPayload<{ select: typeof stateSelect }>): SecretState {
  return {
    id: row.id,
    key: row.key,
    type: row.type,
    revision: row.revision,
    hasValue: row.currentVersionId !== null,
    deleted: row.deletedAt !== null,
  };
}

/** `(id, expected revision)` pairs as a VALUES list for single statement updates. */
function revisionValues(items: readonly { id: string; expectedRevision: number }[]): Prisma.Sql {
  return Prisma.join(
    items.map((item) => Prisma.sql`(${item.id}::uuid, ${item.expectedRevision}::int)`),
  );
}

/**
 * Operations on many variables of one environment at once. Every statement
 * is constrained by the environment scope, so an id from elsewhere never
 * matches; callers compare the number of affected rows with the number they
 * asked for and roll back on a mismatch. Bulk updates are single statements
 * that check each row's revision, so they cannot overwrite concurrent edits.
 */
export class SecretBulkRepository {
  constructor(private readonly db: DbClient) {}

  /** Ids, names and revisions of every variable matching the filters, capped at `max`. */
  async selection(
    scope: EnvironmentScope,
    filters: SecretFilters,
    max: number,
  ): Promise<{ items: { id: string; key: string; revision: number }[]; total: number }> {
    const where = filterWhere(scope, filters);
    const [items, total] = await Promise.all([
      this.db.secret.findMany({
        where,
        orderBy: [{ key: 'asc' }, { id: 'asc' }],
        take: max,
        select: { id: true, key: true, revision: true },
      }),
      this.db.secret.count({ where }),
    ]);
    return { items, total };
  }

  /** Variables by id, live or deleted. Missing or foreign ids are simply absent. */
  async byIds(scope: EnvironmentScope, ids: readonly string[]): Promise<SecretState[]> {
    const rows = await this.db.secret.findMany({
      where: { ...scopeWhere(scope), id: { in: [...ids] } },
      select: stateSelect,
    });
    return rows.map(toState);
  }

  /** Live variables with these names (case sensitive). */
  async liveByKeys(scope: EnvironmentScope, keys: readonly string[]): Promise<SecretState[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.secret.findMany({
      where: { ...scopeWhere(scope), deletedAt: null, key: { in: [...keys] } },
      select: stateSelect,
    });
    return rows.map(toState);
  }

  /** Current encrypted versions of live variables, keyed by secret id. */
  async currentVersions(
    scope: EnvironmentScope,
    ids: readonly string[],
  ): Promise<Map<string, StoredSecretVersion>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.secret.findMany({
      where: { ...scopeWhere(scope), deletedAt: null, id: { in: [...ids] } },
      select: { id: true, currentVersion: { select: storedVersionSelect } },
    });
    return new Map(
      rows.flatMap((row) =>
        row.currentVersion ? [[row.id, toStoredVersion(row.currentVersion)] as const] : [],
      ),
    );
  }

  /** Live variables to export, in name order: the given ids, or all of them. */
  async forExport(
    scope: EnvironmentScope,
    ids: readonly string[] | undefined,
    max: number,
  ): Promise<{ id: string; key: string; type: SecretType; stored: StoredSecretVersion | null }[]> {
    const rows = await this.db.secret.findMany({
      where: {
        ...scopeWhere(scope),
        deletedAt: null,
        ...(ids ? { id: { in: [...ids] } } : {}),
      },
      orderBy: [{ key: 'asc' }, { id: 'asc' }],
      take: max + 1,
      select: {
        id: true,
        key: true,
        type: true,
        currentVersion: { select: storedVersionSelect },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      type: row.type,
      stored: row.currentVersion ? toStoredVersion(row.currentVersion) : null,
    }));
  }

  /**
   * Creates variables with their first version: two statements regardless of
   * the count. Run in a transaction (the current version reference is a
   * deferred foreign key). A name taken meanwhile fails the whole insert.
   */
  async createWithVersions(
    scope: EnvironmentScope,
    rows: readonly { data: NewSecretData; version: NewSecretVersion }[],
    userId: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.secret.createMany({
      data: rows.map(({ data, version }) => ({
        id: data.id,
        ...scopeWhere(scope),
        key: data.key,
        description: data.description,
        type: data.type,
        category: data.category,
        tags: data.tags,
        isRequired: data.isRequired,
        latestVersionNumber: 1,
        currentVersionId: version.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      })),
    });
    await this.db.secretVersion.createMany({
      data: rows.map(({ data, version }) =>
        versionData(scope.workspaceId, data.id, 1, version, userId),
      ),
    });
  }

  /**
   * Gives live variables a new current version if each is still at its
   * expected revision. Returns the ids that were updated; the caller rolls
   * back unless all were. Run in a transaction.
   */
  async overwriteValues(
    scope: EnvironmentScope,
    items: readonly ValueOverwrite[],
    userId: string,
  ): Promise<string[]> {
    if (items.length === 0) return [];
    const updated = await this.db.$queryRaw<{ id: string; latest_version_number: number }[]>`
      UPDATE "secrets" AS s
      SET "latest_version_number" = s."latest_version_number" + 1,
          "current_version_id" = v."version_id",
          "revision" = s."revision" + 1,
          "updated_by_user_id" = ${userId}::uuid,
          "updated_at" = now()
      FROM (VALUES ${Prisma.join(
        items.map(
          (item) =>
            Prisma.sql`(${item.secretId}::uuid, ${item.expectedRevision}::int, ${item.version.id}::uuid)`,
        ),
      )}) AS v("id", "expected_revision", "version_id")
      WHERE s."id" = v."id"
        AND s."revision" = v."expected_revision"
        AND s."deleted_at" IS NULL
        AND s."workspace_id" = ${scope.workspaceId}::uuid
        AND s."project_id" = ${scope.projectId}::uuid
        AND s."environment_id" = ${scope.environmentId}::uuid
      RETURNING s."id", s."latest_version_number"`;
    const numbers = new Map(updated.map((row) => [row.id, row.latest_version_number]));
    const versions = items.flatMap((item) => {
      const number = numbers.get(item.secretId);
      return number === undefined
        ? []
        : [versionData(scope.workspaceId, item.secretId, number, item.version, userId)];
    });
    if (versions.length > 0) await this.db.secretVersion.createMany({ data: versions });
    return [...numbers.keys()];
  }

  /** Soft deletes live variables still at their expected revision; returns the deleted ids. */
  async softDelete(
    scope: EnvironmentScope,
    items: readonly { id: string; expectedRevision: number }[],
    userId: string,
  ): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "secrets" AS s
      SET "deleted_at" = now(), "deleted_by_user_id" = ${userId}::uuid,
          "revision" = s."revision" + 1, "updated_by_user_id" = ${userId}::uuid, "updated_at" = now()
      FROM (VALUES ${revisionValues(items)}) AS v("id", "expected_revision")
      WHERE s."id" = v."id" AND s."revision" = v."expected_revision" AND s."deleted_at" IS NULL
        AND s."workspace_id" = ${scope.workspaceId}::uuid
        AND s."project_id" = ${scope.projectId}::uuid
        AND s."environment_id" = ${scope.environmentId}::uuid
      RETURNING s."id"`;
    return rows.map((r) => r.id);
  }

  /**
   * Restores deleted variables still at their expected revision. A live
   * variable with the same name makes the statement fail
   * (`secrets_environment_key_live_key`), which rolls back the batch.
   */
  async restore(
    scope: EnvironmentScope,
    items: readonly { id: string; expectedRevision: number }[],
    userId: string,
  ): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "secrets" AS s
      SET "deleted_at" = NULL, "deleted_by_user_id" = NULL,
          "revision" = s."revision" + 1, "updated_by_user_id" = ${userId}::uuid, "updated_at" = now()
      FROM (VALUES ${revisionValues(items)}) AS v("id", "expected_revision")
      WHERE s."id" = v."id" AND s."revision" = v."expected_revision" AND s."deleted_at" IS NOT NULL
        AND s."workspace_id" = ${scope.workspaceId}::uuid
        AND s."project_id" = ${scope.projectId}::uuid
        AND s."environment_id" = ${scope.environmentId}::uuid
      RETURNING s."id"`;
    return rows.map((r) => r.id);
  }

  /**
   * Metadata change on live variables still at their expected revision.
   * Added tags are appended (keeping order, without duplicates), removed ones
   * dropped; more than 20 tags fails the CHECK and rolls back the batch.
   */
  async patch(
    scope: EnvironmentScope,
    items: readonly { id: string; expectedRevision: number }[],
    patch: BulkPatch,
    userId: string,
  ): Promise<string[]> {
    const add = patch.addTags ?? [];
    const remove = patch.removeTags ?? [];
    const sets: Prisma.Sql[] = [];
    if (patch.category !== undefined) sets.push(Prisma.sql`"category" = ${patch.category}`);
    if (patch.isRequired !== undefined) sets.push(Prisma.sql`"is_required" = ${patch.isRequired}`);
    if (add.length > 0 || remove.length > 0) {
      sets.push(Prisma.sql`"tags" = ARRAY(
        SELECT u."tag" FROM unnest(array_cat(s."tags", ${add}::text[])) WITH ORDINALITY AS u("tag", "position")
        WHERE NOT (u."tag" = ANY(${remove}::text[]))
        GROUP BY u."tag" ORDER BY min(u."position"))`);
    }
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "secrets" AS s
      SET ${Prisma.join(sets, ', ')},
          "revision" = s."revision" + 1, "updated_by_user_id" = ${userId}::uuid, "updated_at" = now()
      FROM (VALUES ${revisionValues(items)}) AS v("id", "expected_revision")
      WHERE s."id" = v."id" AND s."revision" = v."expected_revision" AND s."deleted_at" IS NULL
        AND s."workspace_id" = ${scope.workspaceId}::uuid
        AND s."project_id" = ${scope.projectId}::uuid
        AND s."environment_id" = ${scope.environmentId}::uuid
      RETURNING s."id"`;
    return rows.map((r) => r.id);
  }
}
