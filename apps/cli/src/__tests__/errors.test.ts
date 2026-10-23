import {
  EnvVaultApiError,
  EnvVaultIncompatibleApiError,
  EnvVaultNetworkError,
} from '@envvault/sdk';
import { describe, expect, it } from 'vitest';
import { CliError, EXIT, toCliError } from '../errors.js';

const api = (statusCode: number, code: string, message = 'Safe message', requestId?: string) =>
  new EnvVaultApiError(statusCode, {
    statusCode,
    code,
    message,
    ...(requestId ? { requestId } : {}),
  });

describe('error mapping', () => {
  it('maps API errors to exit codes', () => {
    expect(toCliError(api(401, 'TOKEN_EXPIRED')).exitCode).toBe(EXIT.auth);
    expect(toCliError(api(401, 'TOKEN_REVOKED')).message).toContain('ended');
    expect(toCliError(api(403, 'FORBIDDEN')).exitCode).toBe(EXIT.forbidden);
    expect(toCliError(api(403, 'CLI_TOKEN_NOT_ALLOWED')).hint).toContain('web app');
    expect(toCliError(api(404, 'NOT_FOUND')).exitCode).toBe(EXIT.notFound);
    expect(toCliError(api(409, 'ENVIRONMENT_ARCHIVED')).exitCode).toBe(EXIT.notFound);
    expect(toCliError(api(429, 'RATE_LIMITED')).exitCode).toBe(EXIT.rateLimited);
    expect(toCliError(api(503, 'UNAVAILABLE', 'x', 'req-1')).exitCode).toBe(EXIT.unavailable);
    expect(toCliError(api(503, 'UNAVAILABLE', 'x', 'req-1')).hint).toBe('Request id req-1');
    expect(toCliError(new EnvVaultNetworkError('timeout')).exitCode).toBe(EXIT.unavailable);
    expect(toCliError(new EnvVaultIncompatibleApiError(2, 1)).exitCode).toBe(EXIT.unavailable);
  });

  it('points protected environments at the confirmation page', () => {
    const error = toCliError(api(403, 'STEP_UP_REQUIRED'), {
      confirmUrl: 'http://localhost:3000/cli/confirm',
    });
    expect(error.exitCode).toBe(EXIT.forbidden);
    expect(error.hint).toContain('http://localhost:3000/cli/confirm');
  });

  it('never echoes unknown errors', () => {
    const leaky = new Error('postgres://user:synthetic-password@db/envvault evv_at_synthetic');
    const error = toCliError(leaky);
    expect(error.message).toBe('Unexpected error.');
    expect(JSON.stringify(error)).not.toContain('synthetic');
  });

  it('passes CLI errors through', () => {
    const original = new CliError('x', EXIT.config);
    expect(toCliError(original)).toBe(original);
  });

  it('hides server error messages for 5xx responses', () => {
    expect(toCliError(api(500, 'INTERNAL', 'stack trace here')).message).not.toContain('stack');
  });
});
