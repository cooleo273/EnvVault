import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface RetentionPolicyRecord {
  workspaceId: string;
  deletedSecretDays: number | null;
  versionKeepCount: number | null;
  versionMinAgeDays: number | null;
  snapshotDays: number | null;
  auditDays: number | null;
  includeProtected: boolean;
  updatedAt: Date;
  updatedBy: { displayName: string | null; email: string } | null;
}

export type RetentionPolicyData = Omit<
  RetentionPolicyRecord,
  'workspaceId' | 'updatedAt' | 'updatedBy'
>;

/** What a purge may remove, resolved to absolute cut off times. */
export interface RetentionCutoffs {
  deletedSecretsBefore: Date | null;
  versions: { keep: number; before: Date } | null;
  snapshotsBefore: Date | null;
  auditBefore: Date | null;
  includeProtected: boolean;
}

export interface RetentionCounts {
  deletedSecrets: number;
  versions: number;
  snapshots: number;
  auditEvents: number;
}

const OPEN_CHANGE_REQUESTS = ['OPEN', 'APPROVED'] as const;

/**
 * Retention queries. Every purge query leaves alone what something still
 * needs: snapshot entries, open change requests, current versions, versions
 * a later version was restored from, and protected environments unless the
 * policy includes them.
 */
export class RetentionRepository {
  constructor(private readonly db: DbClient) {}

  async get(workspaceId: string): Promise<RetentionPolicyRecord | null> {
    const row = await this.db.retentionPolicy.findUnique({
      where: { workspaceId },
      include: { updatedBy: { select: { displayName: true, email: true } } },
    });
    if (!row) return null;
    const { updatedByUserId: _ignored, ...rest } = row;
    return rest;
  }

  async upsert(workspaceId: string, data: RetentionPolicyData, userId: string): Promise<void> {
    await this.db.retentionPolicy.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data, updatedByUserId: userId },
      update: { ...data, updatedByUserId: userId },
    });
  }

  /* ---------------------------------------------------------- deleted secrets */

  private async deletedSecretIds(
    workspaceId: string,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT s."id" FROM "secrets" s
      JOIN "environments" e ON e."workspace_id" = s."workspace_id" AND e."id" = s."environment_id"
      WHERE s."workspace_id" = ${workspaceId}::uuid
        AND s."deleted_at" IS NOT NULL AND s."deleted_at" < ${before}
        AND (${includeProtected} OR NOT e."is_protected")
        AND NOT EXISTS (SELECT 1 FROM "environment_snapshot_entries" se WHERE se."secret_id" = s."id")
        AND NOT EXISTS (
          SELECT 1 FROM "change_request_items" ci
          JOIN "change_requests" cr ON cr."workspace_id" = ci."workspace_id" AND cr."id" = ci."change_request_id"
          WHERE ci."secret_id" = s."id" AND cr."status"::text IN (${OPEN_CHANGE_REQUESTS[0]}, ${OPEN_CHANGE_REQUESTS[1]})
        )
      ORDER BY s."deleted_at", s."id"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** Hard deletes deleted variables (their versions go with them). Returns the ids removed. */
  async purgeDeletedSecrets(
    workspaceId: string,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const ids = await this.deletedSecretIds(workspaceId, before, includeProtected, limit);
    if (ids.length === 0) return [];
    await this.db.secret.deleteMany({
      where: { workspaceId, id: { in: ids }, deletedAt: { not: null } },
    });
    return ids;
  }

  /* ------------------------------------------------------- historical versions */

  private async versionIds(
    workspaceId: string,
    keep: number,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT v."id" FROM (
        SELECT sv."id", sv."secret_id", sv."created_at",
               row_number() OVER (PARTITION BY sv."secret_id" ORDER BY sv."version_number" DESC) AS "rank"
        FROM "secret_versions" sv
        WHERE sv."workspace_id" = ${workspaceId}::uuid
      ) v
      JOIN "secrets" s ON s."id" = v."secret_id"
      JOIN "environments" e ON e."workspace_id" = s."workspace_id" AND e."id" = s."environment_id"
      WHERE v."rank" > ${keep}
        AND v."created_at" < ${before}
        AND s."deleted_at" IS NULL
        AND (s."current_version_id" IS NULL OR s."current_version_id" <> v."id")
        AND (${includeProtected} OR NOT e."is_protected")
        AND NOT EXISTS (SELECT 1 FROM "environment_snapshot_entries" se WHERE se."secret_version_id" = v."id")
        AND NOT EXISTS (
          SELECT 1 FROM "secret_versions" later
          WHERE later."secret_id" = v."secret_id" AND later."restored_from_version_id" = v."id"
        )
      ORDER BY v."created_at", v."id"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async purgeVersions(
    workspaceId: string,
    keep: number,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const ids = await this.versionIds(workspaceId, keep, before, includeProtected, limit);
    if (ids.length === 0) return [];
    await this.db.secretVersion.deleteMany({ where: { workspaceId, id: { in: ids } } });
    return ids;
  }

  /* ---------------------------------------------------------------- snapshots */

  private async snapshotIds(
    workspaceId: string,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT sn."id" FROM "environment_snapshots" sn
      JOIN "environments" e ON e."workspace_id" = sn."workspace_id" AND e."id" = sn."environment_id"
      WHERE sn."workspace_id" = ${workspaceId}::uuid AND sn."created_at" < ${before}
        AND (${includeProtected} OR NOT e."is_protected")
      ORDER BY sn."created_at", sn."id"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async purgeSnapshots(
    workspaceId: string,
    before: Date,
    includeProtected: boolean,
    limit: number,
  ): Promise<string[]> {
    const ids = await this.snapshotIds(workspaceId, before, includeProtected, limit);
    if (ids.length === 0) return [];
    await this.db.environmentSnapshot.deleteMany({ where: { workspaceId, id: { in: ids } } });
    return ids;
  }

  /* -------------------------------------------------------------- audit events */

  /**
   * Removes the oldest audit events of a workspace older than `before`, at
   * most `limit`. Sealed events go only as a prefix of their chain, and the
   * last removed seal is kept as a checkpoint so the rest still verifies.
   * Must run in a transaction that holds the seal lock.
   */
  async purgeAuditEvents(workspaceId: string, before: Date, limit: number): Promise<number> {
    await this.db.$executeRaw`SELECT set_config('envvault.retention_purge', 'on', true)`;
    const prefix = await this.db.$queryRaw<
      { seq: bigint; event_id: string; key_id: string; mac: Uint8Array }[]
    >`
      SELECT s."seq", s."event_id", s."key_id", s."mac"
      FROM "audit_seals" s JOIN "audit_events" e ON e."id" = s."event_id"
      WHERE s."chain_id" = ${workspaceId}
        AND s."seq" < COALESCE((
          SELECT min(s2."seq") FROM "audit_seals" s2 JOIN "audit_events" e2 ON e2."id" = s2."event_id"
          WHERE s2."chain_id" = ${workspaceId} AND e2."occurred_at" >= ${before}
        ), 9223372036854775807)
      ORDER BY s."seq"
      LIMIT ${limit}`;
    let removed = 0;
    const last = prefix.at(-1);
    if (last) {
      await this.db.auditSealCheckpoint.create({
        data: {
          chainId: workspaceId,
          seq: last.seq,
          keyId: last.key_id,
          mac: new Uint8Array(last.mac),
          reason: 'retention_purge',
        },
      });
      const ids = prefix.map((p) => p.event_id);
      await this.db.auditSeal.deleteMany({ where: { eventId: { in: ids } } });
      removed += (await this.db.auditEvent.deleteMany({ where: { id: { in: ids } } })).count;
    }
    if (removed < limit) {
      // Events that were never sealed (sealing off, or older than the first seal).
      const unsealed = await this.db.auditEvent.findMany({
        where: { workspaceId, occurredAt: { lt: before }, seal: { is: null } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: limit - removed,
        select: { id: true },
      });
      if (unsealed.length > 0) {
        removed += (
          await this.db.auditEvent.deleteMany({ where: { id: { in: unsealed.map((u) => u.id) } } })
        ).count;
      }
    }
    return removed;
  }

  /* ------------------------------------------------------------------ preview */

  async counts(
    workspaceId: string,
    cutoffs: RetentionCutoffs,
    cap: number,
  ): Promise<RetentionCounts> {
    const p = cutoffs.includeProtected;
    const [deletedSecrets, versions, snapshots, auditEvents] = await Promise.all([
      cutoffs.deletedSecretsBefore
        ? this.deletedSecretIds(workspaceId, cutoffs.deletedSecretsBefore, p, cap).then(
            (r) => r.length,
          )
        : 0,
      cutoffs.versions
        ? this.versionIds(workspaceId, cutoffs.versions.keep, cutoffs.versions.before, p, cap).then(
            (r) => r.length,
          )
        : 0,
      cutoffs.snapshotsBefore
        ? this.snapshotIds(workspaceId, cutoffs.snapshotsBefore, p, cap).then((r) => r.length)
        : 0,
      cutoffs.auditBefore
        ? this.db.auditEvent.count({
            where: { workspaceId, occurredAt: { lt: cutoffs.auditBefore } },
          })
        : 0,
    ]);
    return { deletedSecrets, versions, snapshots, auditEvents };
  }
}

/* ------------------------------------------------------------ maintenance jobs */

export type MaintenanceJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface MaintenanceJobRecord {
  id: string;
  workspaceId: string;
  kind: string;
  status: MaintenanceJobStatus;
  parameters: Prisma.JsonValue;
  progress: Prisma.JsonValue;
  errorCode: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  requestedBy: { displayName: string | null; email: string } | null;
}

const jobSelect = {
  id: true,
  workspaceId: true,
  kind: true,
  status: true,
  parameters: true,
  progress: true,
  errorCode: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  requestedBy: { select: { displayName: true, email: true } },
} as const;

export class MaintenanceJobRepository {
  constructor(private readonly db: DbClient) {}

  async enqueue(
    workspaceId: string,
    kind: 'retention',
    parameters: Prisma.InputJsonObject,
    userId: string,
  ): Promise<MaintenanceJobRecord> {
    const row = await this.db.maintenanceJob.create({
      data: { workspaceId, kind, parameters, requestedByUserId: userId },
      select: jobSelect,
    });
    return row as MaintenanceJobRecord;
  }

  async get(workspaceId: string, id: string): Promise<MaintenanceJobRecord | null> {
    const row = await this.db.maintenanceJob.findFirst({
      where: { workspaceId, id },
      select: jobSelect,
    });
    return row as MaintenanceJobRecord | null;
  }

  async list(workspaceId: string, take: number): Promise<MaintenanceJobRecord[]> {
    const rows = await this.db.maintenanceJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      select: jobSelect,
    });
    return rows as MaintenanceJobRecord[];
  }

  /**
   * Claims the oldest queued job, or a running one whose worker stopped
   * sending heartbeats. SKIP LOCKED lets several workers poll safely.
   */
  async claim(staleBefore: Date, maxAttempts: number): Promise<MaintenanceJobRecord | null> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "maintenance_jobs" SET
        "status" = 'running', "attempts" = "attempts" + 1,
        "started_at" = COALESCE("started_at", now()), "heartbeat_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "maintenance_jobs"
        WHERE ("status" = 'queued' OR ("status" = 'running' AND "heartbeat_at" < ${staleBefore}))
          AND "attempts" < ${maxAttempts}
        ORDER BY "created_at" LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    const id = rows[0]?.id;
    if (!id) return null;
    const row = await this.db.maintenanceJob.findUnique({ where: { id }, select: jobSelect });
    return row as MaintenanceJobRecord | null;
  }

  /** Jobs that kept failing to finish are marked failed instead of retried forever. */
  async failAbandoned(staleBefore: Date, maxAttempts: number): Promise<number> {
    const result = await this.db.maintenanceJob.updateMany({
      where: {
        status: 'running',
        heartbeatAt: { lt: staleBefore },
        attempts: { gte: maxAttempts },
      },
      data: { status: 'failed', errorCode: 'ABANDONED', finishedAt: new Date() },
    });
    return result.count;
  }

  async heartbeat(id: string, progress: Prisma.InputJsonObject): Promise<void> {
    await this.db.maintenanceJob.update({
      where: { id },
      data: { progress, heartbeatAt: new Date() },
    });
  }

  async finish(
    id: string,
    status: 'succeeded' | 'failed',
    progress: Prisma.InputJsonObject,
    errorCode: string | null = null,
  ): Promise<void> {
    await this.db.maintenanceJob.update({
      where: { id },
      data: { status, progress, errorCode, finishedAt: new Date(), heartbeatAt: new Date() },
    });
  }
}
