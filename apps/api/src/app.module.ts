import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RATE_LIMIT_STORAGE } from './rate-limit/sensitive-rate-limiter.js';
import { UserRateLimitGuard } from './rate-limit/user-rate-limit.guard.js';
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
import { IntegrityKeys } from '@envvault/crypto';
import type { IntegrityRuntime } from './integrity/integrity.config.js';
import { IntegrityModule } from './integrity/integrity.module.js';
import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RetentionModule } from './retention/retention.module.js';
import { CliAuthModule } from './cli-auth/cli-auth.module.js';
import { SecretsModule } from './secrets/secrets.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

export interface AppModuleOptions {
  /** Loaded by loadEncryption() before the app starts. Default: disabled. */
  encryption?: EncryptionRuntime;
  /** Loaded by loadIntegrity() before the app starts. Default: process local keys. */
  integrity?: IntegrityRuntime;
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
        RateLimitModule,
        // Storage is shared (Redis) when RATE_LIMIT_STORE=redis, per instance otherwise.
        ThrottlerModule.forRootAsync({
          inject: [APP_ENV, RATE_LIMIT_STORAGE],
          useFactory: (config: Env, storage: ThrottlerStorage) => ({
            storage,
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
        IntegrityModule.register(
          options.integrity ?? { status: 'ephemeral', keys: IntegrityKeys.ephemeral() },
        ),
        HealthModule,
        AuthModule,
        WorkspacesModule,
        ProjectsModule,
        SecretsModule,
        IntelligenceModule,
        RetentionModule,
        CliAuthModule,
      ],
      providers: [
        // Global guards run in this order: address limit, authenticate, user limit, authorize.
        // Every route is authenticated and must declare an authorization
        // requirement unless explicitly @Public() (default deny).
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: UserRateLimitGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
