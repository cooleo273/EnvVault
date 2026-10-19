import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvValidationError } from './config/env.js';
import { loadEnv } from './config/load-env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
    // Body parsing is configured explicitly (with size limits) in configureApp.
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, env);

  await app.listen(env.API_PORT, env.API_HOST);
  app.get(Logger).log(`EnvVault API listening on http://${env.API_HOST}:${env.API_PORT}`);
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof EnvValidationError) {
    // The logger is not available before configuration is valid.
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Failed to start EnvVault API: ${String(error)}\n`);
  }
  process.exit(1);
}
