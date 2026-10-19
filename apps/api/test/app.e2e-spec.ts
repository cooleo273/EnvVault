import type { DatabaseHealth } from '@envvault/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
} from '@envvault/shared';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parseEnv } from '../src/config/env.js';
import { DatabaseService } from '../src/database/database.service.js';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const DB_DOWN: DatabaseHealth = { status: 'down', reason: 'unreachable' };

interface TestAppOptions {
  dbHealth?: () => Promise<DatabaseHealth>;
  env?: Record<string, string>;
}

async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // Never contacted: the database service is replaced below.
    DATABASE_URL: 'postgresql://envvault:placeholder@127.0.0.1:1/envvault',
    CORS_ORIGINS: ALLOWED_ORIGIN,
    NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
    ...options.env,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(DatabaseService)
    .useValue({
      health: options.dbHealth ?? (() => Promise.resolve({ status: 'up', latencyMs: 1 })),
    })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, env);
  await app.init();
  return app;
}

describe('EnvVault API (e2e)', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('GET /api/v1/health', () => {
    it('returns a schema-valid liveness payload', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
      const body = healthResponseSchema.parse(response.body);
      expect(body).toMatchObject({ status: 'ok', service: 'envvault-api' });
    });

    it('stays live even when the database is down', async () => {
      app = await createTestApp({ dbHealth: () => Promise.resolve(DB_DOWN) });
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    });

    it('is only served under the versioned prefix', async () => {
      app = await createTestApp();
      await request(app.getHttpServer()).get('/health').expect(404);
      await request(app.getHttpServer()).get('/api/health').expect(404);
      await request(app.getHttpServer()).get('/api/v2/health').expect(404);
    });
  });

  describe('GET /api/v1/health/ready', () => {
    it('returns 200 when the database is reachable', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(readinessResponseSchema.parse(response.body).checks.database?.status).toBe('up');
    });

    it('returns 503 when the database is unreachable', async () => {
      app = await createTestApp({ dbHealth: () => Promise.resolve(DB_DOWN) });
      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(readinessResponseSchema.parse(response.body)).toMatchObject({
        status: 'error',
        checks: { database: { status: 'down' } },
      });
    });
  });

  describe('request IDs', () => {
    it('generates a request ID when none is supplied', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates a well-formed client request ID', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('x-request-id', 'trace-abc-12345');
      expect(response.headers['x-request-id']).toBe('trace-abc-12345');
    });

    it('replaces a malformed client request ID', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('x-request-id', 'bad id with spaces');
      expect(response.headers['x-request-id']).not.toBe('bad id with spaces');
    });
  });

  describe('error handling', () => {
    it('returns the uniform error envelope for unknown routes', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      const { error } = apiErrorResponseSchema.parse(response.body);
      expect(error).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(error.requestId).toBe(response.headers['x-request-id']);
      expect(JSON.stringify(response.body)).not.toMatch(/stack|at .*\.ts/);
    });

    it('rejects malformed JSON with a 400 envelope', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .post('/api/v1/health')
        .set('Content-Type', 'application/json')
        .send('{"broken": ')
        .expect(400);
      expect(apiErrorResponseSchema.parse(response.body).error.code).toBe('BAD_REQUEST');
    });

    it('rejects oversized JSON bodies with a 413 envelope', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .post('/api/v1/health')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ data: 'x'.repeat(150 * 1024) }))
        .expect(413);
      expect(apiErrorResponseSchema.parse(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('security headers and CORS', () => {
    it('sets security headers and hides the framework', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('allows configured origins', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not grant CORS to unknown origins', async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example.com');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with the error envelope once the limit is exceeded', async () => {
      app = await createTestApp({ env: { RATE_LIMIT_MAX: '2' } });
      const server = app.getHttpServer();
      await request(server).get('/api/v1/health').expect(200);
      await request(server).get('/api/v1/health').expect(200);
      const response = await request(server).get('/api/v1/health').expect(429);

      expect(apiErrorResponseSchema.parse(response.body).error.code).toBe('TOO_MANY_REQUESTS');
      expect(response.headers['retry-after']).toBeDefined();
    });
  });

  it('logs nothing to stdout when LOG_LEVEL is silent', async () => {
    const write = vi.spyOn(process.stdout, 'write');
    app = await createTestApp();
    await request(app.getHttpServer()).get('/api/v1/health');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
