import { describe, expect, it } from 'vitest';
import { EnvValidationError, neonAuthSettings, parseEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://envvault:placeholder@localhost:5432/envvault',
  CORS_ORIGINS: 'http://localhost:3000',
  NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
};

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TTL_SECONDS: 60,
      RATE_LIMIT_MAX: 100,
      TRUST_PROXY: false,
      CORS_ORIGINS: ['http://localhost:3000'],
    });
  });

  it('parses and normalises a comma-separated origin list', () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: ' http://localhost:3000/ , https://app.example.com/path ',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'https://app.example.com']);
  });

  it('coerces numeric and boolean values', () => {
    const env = parseEnv({ ...base, API_PORT: '8080', TRUST_PROXY: 'true' });
    expect(env.API_PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(true);
  });

  it('reports missing required variables by name', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    try {
      parseEnv({});
    } catch (error) {
      expect((error as EnvValidationError).issues).toEqual(
        expect.arrayContaining(['DATABASE_URL: is required', 'CORS_ORIGINS: is required']),
      );
    }
  });

  it('rejects wildcard and non-http origins', () => {
    expect(() => parseEnv({ ...base, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ ...base, CORS_ORIGINS: 'ftp://example.com' })).toThrow(/CORS_ORIGINS/);
  });

  it('rejects non-PostgreSQL database URLs', () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('requires https origins in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/https origins/);
    expect(
      parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' })
        .CORS_ORIGINS,
    ).toEqual(['https://app.example.com']);
  });

  it('never echoes variable values in error messages', () => {
    const secretLookingUrl = 'not-a-url-but-contains-s3cr3t-password';
    try {
      parseEnv({ ...base, DATABASE_URL: secretLookingUrl });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('s3cr3t');
    }
  });

  describe('Neon Auth settings', () => {
    it('derives JWKS, issuer and audience from the Auth URL as documented by Neon', () => {
      const env = parseEnv({ ...base, NEON_AUTH_BASE_URL: `${base.NEON_AUTH_BASE_URL}/` });
      expect(neonAuthSettings(env)).toEqual({
        baseUrl: base.NEON_AUTH_BASE_URL,
        jwksUrl: new URL(`${base.NEON_AUTH_BASE_URL}/.well-known/jwks.json`),
        issuer: 'https://ep-example.neonauth.us-east-1.aws.neon.tech',
        audience: 'https://ep-example.neonauth.us-east-1.aws.neon.tech',
        trustedOrigin: 'http://localhost:3000',
      });
    });

    it('requires the Auth URL', () => {
      const { NEON_AUTH_BASE_URL: _omit, ...rest } = base;
      expect(() => parseEnv(rest)).toThrow(/NEON_AUTH_BASE_URL: is required/);
    });

    it('requires non-local https Auth endpoints in production', () => {
      const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' };
      expect(() =>
        parseEnv({ ...prod, NEON_AUTH_BASE_URL: 'http://ep-x.neonauth.example/neondb/auth' }),
      ).toThrow(/NEON_AUTH_BASE_URL: must be a non-local https URL/);
      expect(() =>
        parseEnv({ ...prod, NEON_AUTH_BASE_URL: 'https://localhost/neondb/auth' }),
      ).toThrow(/NEON_AUTH_BASE_URL/);
      expect(parseEnv(prod).NEON_AUTH_BASE_URL).toBe(base.NEON_AUTH_BASE_URL);
    });

    it('rejects a JWKS URL from a different origin than the Auth URL (branch mix-up)', () => {
      expect(() =>
        parseEnv({
          ...base,
          NEON_AUTH_JWKS_URL:
            'https://ep-other-branch.neonauth.example/neondb/auth/.well-known/jwks.json',
        }),
      ).toThrow(/NEON_AUTH_JWKS_URL: must have the same origin as NEON_AUTH_BASE_URL/);
      expect(
        parseEnv({
          ...base,
          NEON_AUTH_JWKS_URL: `${base.NEON_AUTH_BASE_URL}/.well-known/jwks.json`,
        }).NEON_AUTH_JWKS_URL,
      ).toBeDefined();
    });

    it('does not allow overriding the issuer', () => {
      const env = parseEnv({ ...base, NEON_AUTH_ISSUER: 'https://attacker.example' });
      expect(neonAuthSettings(env).issuer).toBe(
        'https://ep-example.neonauth.us-east-1.aws.neon.tech',
      );
    });

    it('bounds step-up and token-age settings', () => {
      expect(() => parseEnv({ ...base, AUTH_STEP_UP_TTL_SECONDS: '7200' })).toThrow(
        /AUTH_STEP_UP_TTL_SECONDS/,
      );
      expect(() => parseEnv({ ...base, AUTH_MAX_TOKEN_AGE_SECONDS: '86400' })).toThrow(
        /AUTH_MAX_TOKEN_AGE_SECONDS/,
      );
    });
  });
});
