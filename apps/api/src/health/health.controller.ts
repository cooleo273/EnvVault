import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@envvault/shared';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { HealthService } from './health.service.js';

/** Unauthenticated by design: used by load balancers and orchestrator probes. */
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** `GET /api/v1/health` — liveness probe. */
  @Get()
  liveness(): HealthResponse {
    return this.health.liveness();
  }

  /** `GET /api/v1/health/ready` — readiness probe; 503 when a dependency is down. */
  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
