import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.js';

/** Injection token for the validated, immutable application configuration. */
export const APP_ENV = Symbol('APP_ENV');

@Global()
@Module({})
export class AppConfigModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_ENV, useValue: Object.freeze({ ...env }) }],
      exports: [APP_ENV],
    };
  }
}
