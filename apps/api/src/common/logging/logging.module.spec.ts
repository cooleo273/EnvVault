import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.js';
import { Prisma } from '@envvault/database';
import { buildPinoHttpOptions, serializeError, stripQuery } from './logging.module.js';

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

describe('serializeError', () => {
  it('keeps codes and identifiers of database errors, never their message', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Invalid `secretVersion.create()` invocation: ciphertext synthetic-leak-4f2a',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          modelName: 'SecretVersion',
          driverAdapterError: {
            cause: {
              originalCode: '23505',
              originalMessage:
                'duplicate key value violates unique constraint "secrets_environment_key_live_key"',
              detail: 'Key (key)=(synthetic-leak-4f2a) already exists.',
            },
          },
        },
      },
    );
    const output = JSON.stringify(serializeError(error));
    expect(output).not.toContain('synthetic-leak-4f2a');
    expect(serializeError(error)).toEqual({
      type: 'PrismaClientKnownRequestError',
      code: 'P2002',
      model: 'SecretVersion',
      sqlState: '23505',
      constraint: 'secrets_environment_key_live_key',
    });
  });

  it('drops validation error messages, which quote query arguments', () => {
    const error = new Prisma.PrismaClientValidationError('Argument value: "synthetic-leak-91c0"', {
      clientVersion: 'test',
    });
    expect(JSON.stringify(serializeError(error))).not.toContain('synthetic-leak-91c0');
  });

  it('keeps only the name, message and stack of other errors', () => {
    const error = Object.assign(new Error('boom'), { request: { body: 'synthetic-leak-77aa' } });
    const output = serializeError(error);
    expect(output).toMatchObject({ type: 'Error', message: 'boom' });
    expect(JSON.stringify(output)).not.toContain('synthetic-leak-77aa');
  });
});
