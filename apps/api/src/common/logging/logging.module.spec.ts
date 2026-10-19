import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.js';
import { buildPinoHttpOptions, stripQuery } from './logging.module.js';

const env = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://envvault:placeholder@localhost:5432/envvault',
  CORS_ORIGINS: 'http://localhost:3000',
  NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
});

describe('stripQuery', () => {
  it('removes query strings', () => {
    expect(stripQuery('/api/v1/health?token=abc')).toBe('/api/v1/health');
    expect(stripQuery('/api/v1/health')).toBe('/api/v1/health');
    expect(stripQuery(undefined)).toBeUndefined();
  });
});

describe('HTTP request logging', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  it('logs request metadata but never headers, query strings or bodies', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = pinoHttp(buildPinoHttpOptions(env), sink);
    server = createServer((req, res) => {
      logger(req, res);
      req.resume();
      req.on('end', () => {
        res.statusCode = 201;
        res.end();
      });
    });

    const response = await request(server)
      .post('/api/v1/things?token=query-secret')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'session=cookie-secret')
      .set('x-request-id', 'client-request-0001')
      .send({ value: 'body-secret' });

    expect(response.headers['x-request-id']).toBe('client-request-0001');
    const output = lines.join('');
    expect(output).toContain(
      '"req":{"id":"client-request-0001","method":"POST","path":"/api/v1/things"}',
    );
    expect(output).toContain('"path":"/api/v1/things"');
    expect(output).toContain('"statusCode":201');
    for (const secret of ['query-secret', 'header-secret', 'cookie-secret', 'body-secret']) {
      expect(output).not.toContain(secret);
    }
  });
});
