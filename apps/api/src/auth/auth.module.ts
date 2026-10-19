import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import { type Env, neonAuthSettings } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { CREDENTIAL_VERIFIER, TOKEN_VERIFIER } from './auth.tokens.js';
import { NeonPasswordVerifier } from './credential.verifier.js';
import { NeonTokenVerifier } from './neon-token.verifier.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: TOKEN_VERIFIER,
      inject: [APP_ENV],
      useFactory: (env: Env) => {
        const settings = neonAuthSettings(env);
        return new NeonTokenVerifier({
          jwksUrl: settings.jwksUrl,
          issuer: settings.issuer,
          audience: settings.audience,
          maxTokenAgeSeconds: env.AUTH_MAX_TOKEN_AGE_SECONDS,
          clockToleranceSeconds: env.AUTH_CLOCK_TOLERANCE_SECONDS,
        });
      },
    },
    {
      provide: CREDENTIAL_VERIFIER,
      inject: [APP_ENV],
      useFactory: (env: Env) => {
        const settings = neonAuthSettings(env);
        return new NeonPasswordVerifier({
          baseUrl: settings.baseUrl,
          trustedOrigin: settings.trustedOrigin,
        });
      },
    },
  ],
  exports: [TOKEN_VERIFIER, CREDENTIAL_VERIFIER],
})
export class AuthModule {}
