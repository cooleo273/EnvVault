import {
  createRepositories,
  type MaintenanceJobRecord,
  type PrismaClient,
  type RetentionCounts,
  withTransaction,
} from '@envvault/database';

const BATCH = 200;

/** The cut offs fixed when the run was requested, so retries purge exactly the same scope. */
export interface RetentionRunParameters {
  deletedSecretsBefore: string | null;
  versions: { keep: number; before: string } | null;
  snapshotsBefore: string | null;
  auditBefore: string | null;
  includeProtected: boolean;
}

export function isRunParameters(value: unknown): value is RetentionRunParameters {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { includeProtected?: unknown }).includeProtected === 'boolean';
}

export function emptyCounts(): RetentionCounts {
  return { deletedSecrets: 0, versions: 0, snapshots: 0, auditEvents: 0 };
}

export function countsOf(progress: unknown): RetentionCounts {
  const value = (progress ?? {}) as Partial<Record<keyof RetentionCounts, unknown>>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
  return {
    deletedSecrets: n(value.deletedSecrets),
    versions: n(value.versions),
    snapshots: n(value.snapshots),
    auditEvents: n(value.auditEvents),
  };
}

/**
 * Runs one retention job in batches. Each batch is its own transaction, so
 * an interruption leaves whole batches done and the rest untouched; running
 * the job again continues, because every query selects by the same cut offs.
 * Snapshots go first: they are what keeps old variables and versions alive.
 */
export async function runRetention(
  db: PrismaClient,
  job: MaintenanceJobRecord,
  options: { signal?: AbortSignal } = {},
): Promise<RetentionCounts> {
  if (!isRunParameters(job.parameters)) throw new Error('Invalid retention parameters');
  const p = job.parameters;
  const workspaceId = job.workspaceId;
  const counts = countsOf(job.progress);
  const save = () => createRepositories(db).maintenanceJobs.heartbeat(job.id, { ...counts });

  async function drain(
    step: (repos: ReturnType<typeof createRepositories>) => Promise<number>,
    field: keyof RetentionCounts,
  ) {
    for (;;) {
      if (options.signal?.aborted) throw new Error('Retention run interrupted');
      const removed = await withTransaction(db, (tx) => step(createRepositories(tx)));
      counts[field] += removed;
      await save();
      if (removed < BATCH) return;
    }
  }

  if (p.snapshotsBefore) {
    const before = new Date(p.snapshotsBefore);
    await drain(
      async (repos) =>
        (await repos.retention.purgeSnapshots(workspaceId, before, p.includeProtected, BATCH))
          .length,
      'snapshots',
    );
  }
  if (p.deletedSecretsBefore) {
    const before = new Date(p.deletedSecretsBefore);
    await drain(
      async (repos) =>
        (await repos.retention.purgeDeletedSecrets(workspaceId, before, p.includeProtected, BATCH))
          .length,
      'deletedSecrets',
    );
  }
  if (p.versions) {
    const { keep } = p.versions;
    const before = new Date(p.versions.before);
    await drain(
      async (repos) =>
        (await repos.retention.purgeVersions(workspaceId, keep, before, p.includeProtected, BATCH))
          .length,
      'versions',
    );
  }
  if (p.auditBefore) {
    const before = new Date(p.auditBefore);
    await drain(async (repos) => {
      await repos.auditSeals.lock();
      return repos.retention.purgeAuditEvents(workspaceId, before, BATCH);
    }, 'auditEvents');
  }
  return counts;
}
