import type { DatabaseHealth } from '@envvault/database';
import { healthResponseSchema, readinessResponseSchema } from '@envvault/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { DatabaseService } from '../database/database.service.js';
import type { KeyManagementService } from '../encryption/key-management.service.js';
import { HealthService, SERVICE_NAME } from './health.service.js';

function createService(
  health: () => Promise<DatabaseHealth>,
  options: { keys?: KeyManagementService; redis?: Redis | null } = {},
): HealthService {
  return new HealthService(
    { health } as unknown as DatabaseService,
    options.keys ?? ({ isConfigured: false } as unknown as KeyManagementService),
    options.redis ?? null,
  );
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

  it('fails readiness when configured keys are unusable, and only reports the rate limit store', async () => {
    const up = () => Promise.resolve({ status: 'up' as const, latencyMs: 1 });
    const broken = {
      isConfigured: true,
      provider: () => ({ getActiveKeyVersion: () => Promise.reject(new Error('gone')) }),
    } as unknown as KeyManagementService;
    const failing = { ping: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const noKeys = await createService(up, { keys: broken }).readiness();
    expect(noKeys).toMatchObject({ status: 'error', checks: { encryption: { status: 'down' } } });
    const noRedis = await createService(up, { redis: failing }).readiness();
    expect(noRedis).toMatchObject({ status: 'ok', checks: { rateLimitStore: { status: 'down' } } });
  });
});
