import { Module } from '@nestjs/common';
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
