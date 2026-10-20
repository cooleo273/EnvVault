import { Module } from '@nestjs/common';
import { EnvironmentAccessController } from '../environments/environment-access.controller.js';
import { EnvironmentsController } from '../environments/environments.controller.js';
import { TemplatesController } from '../environments/templates.controller.js';
import { ProjectMembersController } from './project-members.controller.js';
import { ProjectsController } from './projects.controller.js';

@Module({
  controllers: [
    ProjectsController,
    ProjectMembersController,
    EnvironmentsController,
    EnvironmentAccessController,
    TemplatesController,
  ],
})
export class ProjectsModule {}
