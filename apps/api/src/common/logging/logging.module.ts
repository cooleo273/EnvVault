import { Module } from '@nestjs/common';
import { isCryptoError } from '@envvault/crypto';
import { summarizeDatabaseError } from '@envvault/database';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { resolveRequestId } from './request-id.js';

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
}

interface SerializedResponse {
  statusCode?: number;
}

/** Strips the query string: query parameters may carry tokens or other secrets. */
export function stripQuery(url: string | undefined): string | undefined {
  return url?.split('?', 1)[0];
}

/**
 * Error serializer. Database errors keep codes and identifiers only (their
 * messages can quote query arguments and row values), crypto errors keep
 * their category, and other errors keep name, message and stack but none of
 * their own properties, which is where libraries attach request details.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  const database = summarizeDatabaseError(error);
  if (database) return { ...database };
  if (isCryptoError(error)) return { type: error.name, code: error.code };
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { type: typeof error };
}

/**
 * Builds pino-http options. Request/response serializers are allow-lists:
 * headers (Authorization, cookies, API keys), query strings and bodies are
 * never logged.
 */
export function buildPinoHttpOptions(env: Env): Options {
  return {
    level: env.LOG_LEVEL,
    genReqId: resolveRequestId,
    serializers: {
      req: (req: SerializedRequest) => ({
        id: req.id,
        method: req.method,
        path: stripQuery(req.url),
      }),
      res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
      err: serializeError,
    },
    // Defence in depth in case a future serializer or log call adds these fields.
    redact: {
      paths: [
        'req.headers',
        'req.body',
        'req.query',
        'res.headers',
        '*.password',
        '*.secret',
        '*.token',
        '*.authorization',
        '*.cookie',
        '*.plaintext',
        '*.dataKey',
        '*.wrappedKey',
        '*.keyring',
        '*.masterKey',
      ],
      censor: '[REDACTED]',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
  ],
})
export class LoggingModule {}
