import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RouteAccessService } from '../openapi/route-access.js';
import { MetaController } from './meta.controller.js';
import { OpenApiController } from '../openapi/openapi.controller.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [DiscoveryModule],
  controllers: [HealthController, MetaController, OpenApiController],
  providers: [HealthService, RouteAccessService],
})
export class HealthModule {}
