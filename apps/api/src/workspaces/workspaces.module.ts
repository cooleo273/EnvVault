import { Module } from '@nestjs/common';
import {
  InvitationsController,
  WorkspaceInvitationsController,
} from '../invitations/invitations.controller.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { MembersController } from '../members/members.controller.js';
import { MAILER, UnconfiguredMailer } from '../notifications/mailer.js';
import { UsersController } from '../users/users.controller.js';
import { WorkspacesController } from './workspaces.controller.js';

@Module({
  controllers: [
    UsersController,
    WorkspacesController,
    MembersController,
    WorkspaceInvitationsController,
    InvitationsController,
  ],
  providers: [
    InvitationsService,
    // EMAIL_PROVIDER (validated in env.ts) only accepts `none` today, so no
    // email is ever sent. Real providers (SMTP, SES, ...) are selected here
    // once one is approved for production.
    { provide: MAILER, useClass: UnconfiguredMailer },
  ],
})
export class WorkspacesModule {}
