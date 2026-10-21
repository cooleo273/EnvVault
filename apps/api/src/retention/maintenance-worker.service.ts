import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createRepositories, type PrismaClient, summarizeDatabaseError } from '@envvault/database';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { runRetention } from './retention-runner.js';

const STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Processes queued maintenance jobs and records their outcome. Several
 * instances can poll: a job is claimed with SKIP LOCKED, and a job whose
 * worker died is picked up again after five minutes without a heartbeat,
 * up to three attempts. Failures are recorded, never dropped.
 */
export async function processNextJob(
  db: PrismaClient,
  options: { signal?: AbortSignal; now?: Date } = {},
): Promise<boolean> {
  const repos = createRepositories(db);
  const staleBefore = new Date((options.now ?? new Date()).getTime() - STALE_MS);
  await repos.maintenanceJobs.failAbandoned(staleBefore, MAX_ATTEMPTS);
  const job = await repos.maintenanceJobs.claim(staleBefore, MAX_ATTEMPTS);
  if (!job) return false;
  try {
    const counts = await runRetention(db, job, options);
    await repos.maintenanceJobs.finish(job.id, 'succeeded', { ...counts });
    await repos.audit.appendSystem({
      workspaceId: job.workspaceId,
      action: 'retention.purge_completed',
      outcome: 'SUCCESS',
      resourceType: 'workspace',
      resourceId: job.workspaceId,
      metadata: { jobId: job.id, ...counts },
    });
  } catch (error) {
    if (options.signal?.aborted) return true;
    const latest = await repos.maintenanceJobs.get(job.workspaceId, job.id);
    const progress = (latest?.progress ?? {}) as Record<string, number>;
    await repos.maintenanceJobs.finish(job.id, 'failed', progress, 'PURGE_FAILED');
    await repos.audit.appendSystem({
      workspaceId: job.workspaceId,
      action: 'retention.purge_failed',
      outcome: 'FAILURE',
      resourceType: 'workspace',
      resourceId: job.workspaceId,
      metadata: {
        jobId: job.id,
        reason:
          summarizeDatabaseError(error)?.code ?? (error instanceof Error ? error.name : 'unknown'),
      },
    });
  }
  return true;
}

@Injectable()
export class MaintenanceWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('MaintenanceWorker');
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly database: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.MAINTENANCE_POLL_SECONDS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.env.MAINTENANCE_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    // A job stopped here is resumed by the next worker after its heartbeat goes stale.
    this.controller.abort();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await createRepositories(this.database.client).idempotency.purgeExpired(new Date(), 1000);
      while (await processNextJob(this.database.client, { signal: this.controller.signal })) {
        if (this.controller.signal.aborted) break;
      }
    } catch (error) {
      const database = summarizeDatabaseError(error);
      this.logger.warn(
        `Maintenance poll failed (${database?.code ?? database?.type ?? 'unexpected'})`,
      );
    } finally {
      this.running = false;
    }
  }
}
