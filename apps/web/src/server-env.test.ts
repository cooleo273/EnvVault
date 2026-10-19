import { describe, expect, it } from 'vitest';
import { parseServerEnv } from './server-env';

const base = {
  NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
  NEON_AUTH_COOKIE_SECRET: 'placeholder-secret-with-at-least-32-chars',
};

describe('parseServerEnv', () => {
  it('applies local development defaults', () => {
    expect(parseServerEnv(base)).toMatchObject({
      APP_BASE_URL: 'http://localhost:3000',
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    });
  });

  it('requires the Neon Auth URL and a long cookie secret without echoing values', () => {
    expect(() => parseServerEnv({})).toThrow(/NEON_AUTH_BASE_URL: is required/);
    try {
      parseServerEnv({ ...base, NEON_AUTH_COOKIE_SECRET: 'short-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(
        'NEON_AUTH_COOKIE_SECRET: must be at least 32 characters',
      );
      expect((error as Error).message).not.toContain('short-secret-value');
    }
  });

  it('requires non-local https URLs in production', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_BASE_URL: 'https://app.example.com' };
    expect(parseServerEnv(prod).APP_BASE_URL).toBe('https://app.example.com');
    expect(() => parseServerEnv({ ...prod, APP_BASE_URL: 'http://localhost:3000' })).toThrow(
      /APP_BASE_URL/,
    );
    expect(() =>
      parseServerEnv({ ...prod, NEON_AUTH_BASE_URL: 'http://ep-x.example/auth' }),
    ).toThrow(/NEON_AUTH_BASE_URL/);
  });
});
