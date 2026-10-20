import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { createRepositories, withTransaction } from '@envvault/database';
import {
  BUILT_IN_ENVIRONMENT_TEMPLATES,
  createEnvironmentTemplateInputSchema,
  type EnvironmentTemplate,
  environmentTemplateEntrySchema,
} from '@envvault/shared';
import { z } from 'zod';
import {
  AllowArchived,
  CurrentPrincipal,
  CurrentWorkspace,
  RequireWorkspacePermission,
} from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, AuthorizedWorkspace, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { requestIdOf } from '../common/request-id.util.js';
import { UuidParam } from '../common/uuid-param.js';
import { DatabaseService } from '../database/database.service.js';
import { mapConstraintError, notFound } from '../projects/project.helpers.js';

const storedEntriesSchema = z.array(environmentTemplateEntrySchema);

/**
 * Environment templates: built-in ones (in code) plus workspace templates.
 * Templates hold names, kinds, defaults and expected key names — never values.
 */
@Controller({ path: 'workspaces/:workspaceId/environment-templates', version: '1' })
export class TemplatesController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @RequireWorkspacePermission('workspace:read')
  @AllowArchived('workspace')
  async list(@CurrentWorkspace() workspace: AuthorizedWorkspace): Promise<EnvironmentTemplate[]> {
    const stored = await createRepositories(this.database.client).templates.list(workspace.scope);
    const custom = stored.flatMap((t) => {
      // Rows are validated on write; skip anything that no longer parses.
      const entries = storedEntriesSchema.safeParse(t.environments);
      return entries.success
        ? [
            {
              id: t.id,
              name: t.name,
              description: t.description,
              builtIn: false,
              environments: entries.data,
            },
          ]
        : [];
    });
    const builtIn = BUILT_IN_ENVIRONMENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      builtIn: true,
      environments: t.environments,
    }));
    return [...builtIn, ...custom];
  }

  @Post()
  @RequireWorkspacePermission('workspace:update')
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @Body(new ZodValidationPipe(createEnvironmentTemplateInputSchema))
    body: z.output<typeof createEnvironmentTemplateInputSchema>,
    @Req() request: AuthenticatedRequest,
  ): Promise<EnvironmentTemplate> {
    try {
      return await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const created = await repos.templates.create(workspace.scope, {
          name: body.name,
          description: body.description,
          environments: JSON.parse(JSON.stringify(body.environments)) as object[],
        });
        await repos.audit.append({
          workspaceId: workspace.scope.workspaceId,
          actorUserId: principal.userId,
          action: 'environment_template.created',
          outcome: 'SUCCESS',
          resourceType: 'environment_template',
          resourceId: created.id,
          requestId: requestIdOf(request),
          metadata: { name: created.name, environments: body.environments.length },
        });
        return {
          id: created.id,
          name: created.name,
          description: created.description,
          builtIn: false,
          environments: body.environments,
        };
      });
    } catch (error) {
      mapConstraintError(error);
    }
  }

  @Delete(':templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspacePermission('workspace:update')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentWorkspace() workspace: AuthorizedWorkspace,
    @UuidParam('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.templates.remove(workspace.scope, templateId))) throw notFound();
      await repos.audit.append({
        workspaceId: workspace.scope.workspaceId,
        actorUserId: principal.userId,
        action: 'environment_template.deleted',
        outcome: 'SUCCESS',
        resourceType: 'environment_template',
        resourceId: templateId,
        requestId: requestIdOf(request),
      });
    });
  }
}
