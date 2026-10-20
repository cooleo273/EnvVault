import type { EnvironmentTemplate } from '@envvault/shared';
import type { Metadata } from 'next';
import { EnvironmentCreateDialog, EnvironmentList } from '@/features/projects/environment-list';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Environments' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const KINDS = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION', 'OTHER'] as const;
const STATUSES = ['active', 'archived', 'all'] as const;

export default async function EnvironmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: SearchParams;
}) {
  const [{ workspaceId, projectId }, query] = await Promise.all([params, searchParams]);
  const project = await getProject(workspaceId, projectId);
  const canCreate =
    project.permissions.includes('environment:create') && project.status === 'ACTIVE';
  const [list, templates] = await withApi((api) =>
    Promise.all([
      api.listEnvironments(workspaceId, projectId, {
        q: one(query.q),
        kind: KINDS.find((k) => k === one(query.kind)),
        status: STATUSES.find((s) => s === one(query.status)) ?? 'active',
        pageSize: 200,
      }),
      canCreate
        ? api.environmentTemplates(workspaceId)
        : Promise.resolve([] as EnvironmentTemplate[]),
    ]),
  ).catch((error: unknown) =>
    handleApiFailure(error, `${projectPath(workspaceId, projectId)}/environments`),
  );

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {list.total} {list.total === 1 ? 'environment' : 'environments'} you can see. Each has its
          own id, settings and access.
        </p>
        {canCreate ? (
          <EnvironmentCreateDialog
            newHref={`${projectPath(workspaceId, projectId)}/environments/new`}
            templates={templates}
          />
        ) : null}
      </div>
      {one(query.deleted) ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Environment deleted.
        </p>
      ) : null}
      <EnvironmentList
        workspaceId={workspaceId}
        projectId={projectId}
        environments={list.items}
        total={list.total}
        canReorder={
          project.permissions.includes('environment:update') && project.status === 'ACTIVE'
        }
      />
    </>
  );
}
