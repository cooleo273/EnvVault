import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { AuthenticationGuard } from './auth/authentication.guard.js';
import { AuthorizationGuard } from './auth/authorization.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { isNotSensitiveRoute } from './common/sensitive-rate-limit.js';
import { APP_ENV, AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import {
  DISABLED_ENCRYPTION,
  EncryptionConfigurationError,
  type EncryptionRuntime,
} from './encryption/encryption.config.js';
import { EncryptionModule } from './encryption/encryption.module.js';
import { HealthModule } from './health/health.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

export interface AppModuleOptions {
  /** Loaded by loadEncryption() before the app starts. Default: disabled. */
  encryption?: EncryptionRuntime;
}

@Module({})
export class AppModule {
  /** The validated environment is passed in explicitly so tests can supply their own. */
  static register(env: Env, options: AppModuleOptions = {}): DynamicModule {
    const encryption = options.encryption ?? DISABLED_ENCRYPTION;
    if (env.ENCRYPTION_PROVIDER !== 'none' && encryption.status !== 'ready') {
      // Never start silently without the keys the configuration asks for.
      throw new EncryptionConfigurationError('the configured key provider was not loaded');
    }
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(env),
        LoggingModule,
        // In-memory rate-limit storage: per-instance only. A shared (Redis) store
        // is required before running multiple API replicas.
        ThrottlerModule.forRootAsync({
          inject: [APP_ENV],
          useFactory: (config: Env) => ({
            throttlers: [
              {
                name: 'default',
                ttl: config.RATE_LIMIT_TTL_SECONDS * 1000,
                limit: config.RATE_LIMIT_MAX,
              },
              {
                name: 'sensitive',
                ttl: 60_000,
                limit: config.RATE_LIMIT_SENSITIVE_MAX,
                skipIf: isNotSensitiveRoute,
              },
            ],
          }),
        }),
        DatabaseModule,
        EncryptionModule.register(encryption),
        HealthModule,
        AuthModule,
        WorkspacesModule,
        ProjectsModule,
      ],
      providers: [
        // Global guards run in this order: rate limit, authenticate, authorize.
        // Every route is authenticated and must declare an authorization
        // requirement unless explicitly @Public() (default deny).
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
