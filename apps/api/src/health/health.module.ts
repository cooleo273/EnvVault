import { Module } from '@nestjs/common';
import { OpenApiController } from '../openapi/openapi.controller.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController, OpenApiController],
  providers: [HealthService],
})
export class HealthModule {}
