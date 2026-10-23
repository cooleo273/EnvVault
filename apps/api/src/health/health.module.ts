import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller.js';
import { OpenApiController } from '../openapi/openapi.controller.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController, MetaController, OpenApiController],
  providers: [HealthService],
})
export class HealthModule {}
