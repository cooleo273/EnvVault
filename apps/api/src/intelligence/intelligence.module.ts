import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ComparisonService } from './comparison.service.js';
import { ConfigurationService } from './configuration.service.js';
import { EnvironmentAccessService } from './environment-access.service.js';
import {
  EnvironmentComparisonController,
  EnvironmentIntelligenceController,
} from './intelligence.controller.js';
import { ReadinessService } from './readiness.service.js';
import { RuntimeService } from './runtime.service.js';
import { SnapshotService } from './snapshot.service.js';
import { ValidationService } from './validation.service.js';

/** Environment comparison, inheritance, validation, readiness and snapshots. */
@Module({
  imports: [SecretsModule],
  controllers: [EnvironmentComparisonController, EnvironmentIntelligenceController],
  providers: [
    EnvironmentAccessService,
    ConfigurationService,
    ComparisonService,
    ValidationService,
    ReadinessService,
    SnapshotService,
    RuntimeService,
  ],
})
export class IntelligenceModule {}
