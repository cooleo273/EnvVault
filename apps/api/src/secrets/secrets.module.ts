import { Module } from '@nestjs/common';
import { SecretAuthorizationService } from './secret-authorization.service.js';
import { SecretsController } from './secrets.controller.js';
import { SecretsService } from './secrets.service.js';

/** Environment variables and their encrypted values. Encryption comes from the global EncryptionModule. */
@Module({
  controllers: [SecretsController],
  providers: [SecretsService, SecretAuthorizationService],
})
export class SecretsModule {}
