import { type DynamicModule, Module } from '@nestjs/common';
import type { EncryptionRuntime } from './encryption.config.js';
import { ENCRYPTION_RUNTIME, KeyManagementService } from './key-management.service.js';
import { SecretEncryptionService } from './secret-encryption.service.js';

/**
 * Envelope encryption for backend services. Has no controllers: nothing here
 * is reachable over HTTP. The runtime (key provider) is loaded and validated
 * before the application is created, see loadEncryption().
 */
@Module({})
export class EncryptionModule {
  static register(runtime: EncryptionRuntime): DynamicModule {
    return {
      module: EncryptionModule,
      global: true,
      providers: [
        { provide: ENCRYPTION_RUNTIME, useValue: runtime },
        KeyManagementService,
        SecretEncryptionService,
      ],
      exports: [KeyManagementService, SecretEncryptionService],
    };
  }
}
