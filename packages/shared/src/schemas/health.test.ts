import { describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '../api.js';
import { healthResponseSchema, readinessResponseSchema } from './health.js';

describe('health schemas', () => {
  it('exposes the versioned base path', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('accepts a valid liveness payload', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'envvault-api',
      version: '0.0.0',
      uptimeSeconds: 1.5,
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown status values and malformed timestamps', () => {
    const result = healthResponseSchema.safeParse({
      status: 'great',
      service: 'envvault-api',
      version: '0.0.0',
      uptimeSeconds: 1,
      timestamp: 'yesterday',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a readiness payload with dependency checks', () => {
    const result = readinessResponseSchema.safeParse({
      status: 'error',
      checks: { database: { status: 'down' } },
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});
