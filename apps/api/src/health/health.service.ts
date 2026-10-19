import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import type { DependencyCheck, HealthResponse, ReadinessResponse } from '@envvault/shared';
import { DatabaseService } from '../database/database.service.js';

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

  constructor(private readonly database: DatabaseService) {}

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

  /** Readiness: the database is reachable and fully migrated. */
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
    return {
      status: database.status === 'up' ? 'ok' : 'error',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
  }
}
