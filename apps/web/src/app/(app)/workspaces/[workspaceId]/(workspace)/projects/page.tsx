import type { Paginated, ProjectSummary } from '@envvault/shared';
import { PlusIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ProjectBrowser } from '@/features/projects/project-browser';
import { withApi } from '@/lib/api/server-api';
import { getWorkspace } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Projects' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const SORTS = ['name', 'updated', 'created', 'recent'] as const;
const STATUSES = ['active', 'archived', 'all'] as const;

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: SearchParams;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspace(workspaceId);
  const sort = SORTS.find((s) => s === one(query.sort)) ?? 'name';
  const status = STATUSES.find((s) => s === one(query.status)) ?? 'active';
  const page = Math.max(1, Number.parseInt(one(query.page) ?? '1', 10) || 1);
  const view = one(query.view) === 'list' ? 'list' : 'grid';

  let result: Paginated<ProjectSummary> | null;
  let recent: ProjectSummary[] = [];
  try {
    [result, recent] = await withApi((api) =>
      Promise.all([
        api.listProjects(workspaceId, {
          q: one(query.q),
          status,
          favorite: one(query.favorite) === 'true' ? 'true' : undefined,
          sort,
          page,
          pageSize: 24,
        }),
        api.listProjects(workspaceId, { sort: 'recent', pageSize: 5 }).then((r) => r.items),
      ]),
    );
  } catch {
    result = null;
  }
  const canCreate = workspace.permissions.includes('project:create') && !workspace.archivedAt;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {result
            ? `${String(result.total)} ${result.total === 1 ? 'project' : 'projects'}`
            : 'Projects'}
          {workspace.permissions.includes('project:read')
            ? ' · You administer every project in this workspace.'
            : ' · Showing projects you are a member of.'}
        </p>
        {canCreate ? (
          <Button asChild>
            <Link href={`/workspaces/${workspaceId}/projects/new`}>
              <PlusIcon aria-hidden="true" />
              New project
            </Link>
          </Button>
        ) : null}
      </div>
      {one(query.deleted) ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Project deleted. It can be recovered by an administrator during the recovery window.
        </p>
      ) : null}
      <ProjectBrowser
        workspaceId={workspaceId}
        result={result}
        recent={recent}
        view={view}
        canCreate={canCreate}
      />
    </>
  );
}
