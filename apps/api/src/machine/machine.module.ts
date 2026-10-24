import { Global, Module } from '@nestjs/common';
import { EnvironmentAccessService } from '../intelligence/environment-access.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { MachineAccessService } from './machine-access.service.js';
import { MachineAuthService } from './machine-auth.service.js';
import { MachineIdentitiesController } from './machine-identities.controller.js';
import { MachineIdentitiesService } from './machine-identities.service.js';
import { MachineController } from './machine.controller.js';

/** Global so the authentication guard can resolve machine access tokens. */
@Global()
@Module({
  imports: [SecretsModule],
  controllers: [MachineController, MachineIdentitiesController],
  providers: [
    MachineAuthService,
    MachineAccessService,
    MachineIdentitiesService,
    EnvironmentAccessService,
  ],
  exports: [MachineAuthService],
})
export class MachineModule {}
