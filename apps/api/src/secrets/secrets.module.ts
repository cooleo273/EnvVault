import { Module } from '@nestjs/common';
import { SecretAuthorizationService } from './secret-authorization.service.js';
import { SecretBulkService } from './secret-bulk.service.js';
import { SecretExportService } from './secret-export.service.js';
import { SecretHistoryService } from './secret-history.service.js';
import { SecretImportService } from './secret-import.service.js';
import { SecretRateLimiter } from './secret-rate-limiter.js';
import { SecretTransfersController } from './secret-transfers.controller.js';
import { SecretVault } from './secret-vault.service.js';
import { SecretsController } from './secrets.controller.js';
import { SecretsService } from './secrets.service.js';

/** Environment variables and their encrypted values. Encryption comes from the global EncryptionModule. */
@Module({
  // Order matters: the fixed paths of SecretTransfersController must be
  // registered before the `:secretId` routes.
  controllers: [SecretTransfersController, SecretsController],
  providers: [
    SecretVault,
    SecretAuthorizationService,
    SecretRateLimiter,
    SecretsService,
    SecretHistoryService,
    SecretImportService,
    SecretExportService,
    SecretBulkService,
  ],
  // The environment intelligence features use the same crypto, authorization and limits.
  exports: [SecretVault, SecretAuthorizationService, SecretRateLimiter],
})
export class SecretsModule {}
