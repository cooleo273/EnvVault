import { Module } from '@nestjs/common';
import { MaintenanceWorkerService } from './maintenance-worker.service.js';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';

@Module({
  controllers: [RetentionController],
  providers: [RetentionService, MaintenanceWorkerService],
  exports: [MaintenanceWorkerService],
})
export class RetentionModule {}
