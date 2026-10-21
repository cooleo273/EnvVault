import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DependencyCheck, HealthResponse, ReadinessResponse } from '@envvault/shared';
import { DatabaseService } from '../database/database.service.js';
import { KeyManagementService } from '../encryption/key-management.service.js';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.module.js';

export const SERVICE_NAME = 'envvault-api';

function readPackageVersion(): string {
  // Resolves to apps/api/package.json from both src/ (tests) and dist/ (runtime).
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? 'unknown';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly version = readPackageVersion();

  constructor(
    private readonly database: DatabaseService,
    private readonly keys: KeyManagementService,
    @Inject(RATE_LIMIT_REDIS) private readonly redis: Redis | null,
  ) {}

  /** Liveness: the process is up and able to serve requests. No dependency checks. */
  liveness(): HealthResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: this.version,
      uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: the database is reachable and migrated, and configured keys
   * are usable. The shared rate limit store is reported but does not decide
   * readiness: while it is down only sensitive actions are refused, and
   * taking every instance out of rotation would refuse everything.
   */
  async readiness(): Promise<ReadinessResponse> {
    let database: DependencyCheck;
    try {
      const health = await this.database.health();
      if (health.status === 'down') {
        // The reason is an internal diagnostic and is logged, not returned.
        this.logger.warn(`Readiness check failed: database ${health.reason ?? 'down'}`);
      }
      database =
        health.latencyMs === undefined
          ? { status: health.status }
          : { status: health.status, latencyMs: health.latencyMs };
    } catch {
      // Never surface error details: they can contain hostnames or credentials.
      this.logger.warn('Readiness check failed: database check errored');
      database = { status: 'down' };
    }
    const checks: Record<string, DependencyCheck> = { database };
    if (this.keys.isConfigured) {
      checks.encryption = await this.keys
        .provider()
        .getActiveKeyVersion()
        .then((): DependencyCheck => ({ status: 'up' }))
        .catch((): DependencyCheck => ({ status: 'down' }));
    }
    if (this.redis) {
      const started = Date.now();
      checks.rateLimitStore = await this.redis
        .ping()
        .then((): DependencyCheck => ({ status: 'up', latencyMs: Date.now() - started }))
        .catch((): DependencyCheck => ({ status: 'down' }));
    }
    const ready = database.status === 'up' && checks.encryption?.status !== 'down';
    return {
      status: ready ? 'ok' : 'error',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
