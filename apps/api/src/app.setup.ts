import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_DEFAULT_VERSION, API_PREFIX, REQUEST_ID_HEADER } from '@envvault/shared';
import helmet from 'helmet';
import type { Env } from './config/env.js';

const MAX_JSON_BODY = '100kb';

/**
 * Applies HTTP-level configuration. Shared by `main.ts` and the e2e tests so
 * tests exercise exactly the production middleware stack.
 */
export function configureApp(app: NestExpressApplication, env: Env): NestExpressApplication {
  if (env.TRUST_PROXY) {
    // Needed for correct client IPs (rate limiting) behind a single trusted proxy hop.
    app.set('trust proxy', 1);
  }

  app.use(helmet());
  app.useBodyParser('json', { limit: MAX_JSON_BODY });

  app.enableCors({
    // Exact-match allow-list; requests from other origins get no CORS headers.
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600,
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_DEFAULT_VERSION });
  app.enableShutdownHooks();

  return app;
}
