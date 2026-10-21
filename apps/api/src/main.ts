import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvValidationError } from './config/env.js';
import { loadEnv } from './config/load-env.js';
import { EncryptionConfigurationError, loadEncryption } from './encryption/encryption.config.js';
import { IntegrityConfigurationError, loadIntegrity } from './integrity/integrity.config.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // Keys are validated before anything else starts; a broken keyring stops start-up.
  const encryption = await loadEncryption(env);
  const integrity = await loadIntegrity(env);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env, { encryption, integrity }),
    {
      bufferLogs: true,
      // Body parsing is configured explicitly (with size limits) in configureApp.
      bodyParser: false,
    },
  );
  app.useLogger(app.get(Logger));
  configureApp(app, env);

  await app.listen(env.API_PORT, env.API_HOST);
  const logger = app.get(Logger);
  logger.log(`EnvVault API listening on http://${env.API_HOST}:${env.API_PORT}`);
  if (env.NODE_ENV === 'production') {
    if (env.RATE_LIMIT_STORE === 'memory') {
      logger.warn(
        'Rate limits are counted per instance (RATE_LIMIT_STORE=memory); run one instance or use redis',
      );
    }
    if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
      logger.warn(`LOG_LEVEL=${env.LOG_LEVEL} in production`);
    }
  }
  // Shutdown hooks close the server and the database on SIGTERM; never hang past the platform's grace period.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        process.stderr.write('Shutdown took too long; exiting\n');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
    });
  }
}

const SHUTDOWN_TIMEOUT_MS = 25_000;

try {
  await bootstrap();
} catch (error) {
  if (
    error instanceof EnvValidationError ||
    error instanceof EncryptionConfigurationError ||
    error instanceof IntegrityConfigurationError
  ) {
    // The logger is not available before configuration is valid.
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Failed to start EnvVault API: ${String(error)}\n`);
  }
  process.exit(1);
}
