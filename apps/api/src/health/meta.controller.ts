import { Controller, Get } from '@nestjs/common';
import { API_FEATURES, API_PROTOCOL_VERSION, type MetaResponse } from '@envvault/shared';
import { Public } from '../auth/auth.decorators.js';
import { HealthService, SERVICE_NAME } from './health.service.js';

/** What this API speaks, so clients can refuse an incompatible server before calling it. */
@Public()
@Controller({ path: 'meta', version: '1' })
export class MetaController {
  constructor(private readonly health: HealthService) {}

  @Get()
  meta(): MetaResponse {
    return {
      service: SERVICE_NAME,
      version: this.health.liveness().version,
      protocolVersion: API_PROTOCOL_VERSION,
      features: [...API_FEATURES],
    };
  }
}
