import { Global, Module } from '@nestjs/common';
import { CliAuthController } from './cli-auth.controller.js';
import { CliAuthService } from './cli-auth.service.js';

/** Global so the authentication guard can check CLI sessions. */
@Global()
@Module({
  controllers: [CliAuthController],
  providers: [CliAuthService],
  exports: [CliAuthService],
})
export class CliAuthModule {}
