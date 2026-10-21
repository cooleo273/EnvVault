import { type DynamicModule, Module } from '@nestjs/common';
import { AuditSealerService } from './audit-sealer.service.js';
import { INTEGRITY_RUNTIME, type IntegrityRuntime } from './integrity.config.js';

/** Integrity keys (loaded before the app starts) and the audit sealer. */
@Module({})
export class IntegrityModule {
  static register(runtime: IntegrityRuntime): DynamicModule {
    return {
      module: IntegrityModule,
      global: true,
      providers: [{ provide: INTEGRITY_RUNTIME, useValue: runtime }, AuditSealerService],
      exports: [INTEGRITY_RUNTIME, AuditSealerService],
    };
  }
}
