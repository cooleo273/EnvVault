import type { DatabaseHealth } from '@envvault/database';
import { healthResponseSchema, readinessResponseSchema } from '@envvault/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { HealthService, SERVICE_NAME } from './health.service.js';

function createService(health: () => Promise<DatabaseHealth>): HealthService {
  return new HealthService({ health } as unknown as DatabaseService);
}

describe('HealthService', () => {
  it('reports liveness without touching dependencies', () => {
    const health = vi.fn<() => Promise<DatabaseHealth>>();
    const result = createService(health).liveness();

    expect(healthResponseSchema.parse(result)).toEqual(result);
    expect(result.status).toBe('ok');
    expect(result.service).toBe(SERVICE_NAME);
    expect(result.version).toBe('0.0.0');
    expect(health).not.toHaveBeenCalled();
  });

  it('reports ready when the database is up and migrated', async () => {
    const result = await createService(() =>
      Promise.resolve({ status: 'up', latencyMs: 3 }),
    ).readiness();

    expect(readinessResponseSchema.parse(result)).toEqual(result);
    expect(result.status).toBe('ok');
    expect(result.checks.database).toEqual({ status: 'up', latencyMs: 3 });
  });

  it('reports not ready without exposing the internal reason', async () => {
    const result = await createService(() =>
      Promise.resolve({ status: 'down', latencyMs: 2, reason: 'migrations_failed' }),
    ).readiness();

    expect(result.status).toBe('error');
    expect(result.checks.database).toEqual({ status: 'down', latencyMs: 2 });
    expect(JSON.stringify(result)).not.toContain('migrations_failed');
  });

  it('never leaks error details if the check itself throws', async () => {
    const result = await createService(() =>
      Promise.reject(new Error('connect ECONNREFUSED postgres://admin:secret@db:5432')),
    ).readiness();

    expect(result.checks.database).toEqual({ status: 'down' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
