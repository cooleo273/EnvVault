import { Module } from '@nestjs/common';
import { EnvironmentAccessService } from '../intelligence/environment-access.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService, vercelClientFactoryProvider } from './integrations.service.js';

/** Deployment integrations (Vercel). Credentials and values use the global encryption and the secret vault. */
@Module({
  imports: [SecretsModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationSyncService,
    EnvironmentAccessService,
    vercelClientFactoryProvider,
  ],
})
export class IntegrationsModule {}
