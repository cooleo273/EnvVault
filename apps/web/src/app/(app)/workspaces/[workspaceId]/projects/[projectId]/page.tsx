import type { ActivityEvent, EnvironmentSummary } from '@envvault/shared';
import { Layers, PlusIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { ActivityList } from '@/features/projects/activity-list';
import { EnvironmentCard } from '@/features/projects/environment-card';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Project' };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/** ProjectOverview: real counts, environments at a glance and recent activity. */
export default async function ProjectOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const [{ workspaceId, projectId }, query] = await Promise.all([params, searchParams]);
  const project = await getProject(workspaceId, projectId);
  const base = projectPath(workspaceId, projectId);
  let environments: EnvironmentSummary[] = [];
  let activity: ActivityEvent[] = [];
  try {
    const [envs, events] = await withApi((api) =>
      Promise.all([
        api.listEnvironments(workspaceId, projectId, { pageSize: 12 }),
        api.projectActivity(workspaceId, projectId, { limit: 6 }),
      ]),
    );
    environments = envs.items;
    activity = events.items;
  } catch {
    // Sections below show their empty states.
  }
  const canCreate =
    project.permissions.includes('environment:create') && project.status === 'ACTIVE';

  return (
    <>
      {query.created ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Project created. You are its Project Admin.
        </p>
      ) : null}
      {project.description ? (
        <p className="max-w-3xl text-sm text-muted-foreground">{project.description}</p>
      ) : null}

      <dl className="grid divide-y rounded-lg border bg-surface sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {[
          ['Environments', String(project.environmentCount)],
          ['Protected', String(project.protectedEnvironmentCount)],
          ['Members', String(project.memberCount)],
          ['Created', dateFormat.format(new Date(project.createdAt))],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 px-4 py-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="overview-environments" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="overview-environments" className="text-sm font-semibold">
            Environments
          </h2>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`${base}/environments`}>View all</Link>
            </Button>
            {canCreate ? (
              <Button size="sm" asChild>
                <Link href={`${base}/environments/new`}>
                  <PlusIcon aria-hidden="true" />
                  New environment
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
        {environments.length === 0 ? (
          <div className="rounded-lg border bg-surface">
            <EmptyState
              icon={Layers}
              title="No environments yet"
              description="Add Development, QA, Production or any custom environment."
            />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {environments.map((env) => (
              <EnvironmentCard
                key={env.id}
                href={`${base}/environments/${env.id}`}
                environment={env}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="overview-activity" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 id="overview-activity" className="text-sm font-semibold">
            Recent activity
          </h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`${base}/activity`}>View all</Link>
          </Button>
        </div>
        <ActivityList events={activity} />
      </section>
    </>
  );
}
