import { Global, Module } from '@nestjs/common';
import { EnvironmentAccessService } from '../intelligence/environment-access.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { MachineAccessService } from './machine-access.service.js';
import { MachineAuthService } from './machine-auth.service.js';
import { MachineIdentitiesController } from './machine-identities.controller.js';
import { MachineIdentitiesService } from './machine-identities.service.js';
import { MachineController } from './machine.controller.js';
import { OidcBindingsController } from './oidc-bindings.controller.js';
import { OidcBindingsService } from './oidc-bindings.service.js';
import { OidcExchangeService } from './oidc-exchange.service.js';
import { oidcVerifierProvider } from './oidc-verifier.provider.js';

/** Global so the authentication guard can resolve machine access tokens. */
@Global()
@Module({
  imports: [SecretsModule],
  controllers: [MachineController, MachineIdentitiesController, OidcBindingsController],
  providers: [
    MachineAuthService,
    MachineAccessService,
    MachineIdentitiesService,
    EnvironmentAccessService,
    OidcExchangeService,
    OidcBindingsService,
    oidcVerifierProvider,
  ],
  exports: [MachineAuthService],
})
export class MachineModule {}
