import type { ProjectDetail, WorkspaceDetail } from '@envvault/shared';
import { Archive } from 'lucide-react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { Breadcrumbs, type BreadcrumbItem } from '@/components/layout/page-header';
import { WorkspaceTabs } from '@/features/workspaces/workspace-tabs';
import { FavoriteToggle } from './favorite-toggle';
import { ProjectAvatar } from './visual';

/** Workspace › Projects › Project › (optional trail). */
export function ProjectBreadcrumbs({
  workspace,
  project,
  trail = [],
}: {
  workspace: Pick<WorkspaceDetail, 'id' | 'name'>;
  project: Pick<ProjectDetail, 'id' | 'name'>;
  trail?: BreadcrumbItem[];
}) {
  const base = `/workspaces/${workspace.id}`;
  return (
    <Breadcrumbs
      items={[
        { label: workspace.name, href: base },
        { label: 'Projects', href: `${base}/projects` },
        trail.length
          ? { label: project.name, href: `${base}/projects/${project.id}` }
          : { label: project.name },
        ...trail,
      ]}
    />
  );
}

export function ProjectHeader({
  workspace,
  project,
}: {
  workspace: Pick<WorkspaceDetail, 'id' | 'name' | 'archivedAt'>;
  project: ProjectDetail;
}) {
  const base = `/workspaces/${workspace.id}/projects/${project.id}`;
  const can = (p: string) => project.permissions.includes(p);
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/environments`, label: 'Environments' },
    { href: `${base}/compare`, label: 'Compare' },
    ...(can('project_member:read') ? [{ href: `${base}/members`, label: 'Members' }] : []),
    { href: `${base}/activity`, label: 'Activity' },
    ...(can('project:update') || can('project:archive') || can('project:delete')
      ? [{ href: `${base}/settings`, label: 'Settings' }]
      : []),
  ];
  return (
    <>
      <div className="flex flex-col gap-3">
        <ProjectBreadcrumbs workspace={workspace} project={project} />
        <div className="flex items-start gap-3">
          <ProjectAvatar icon={project.icon} color={project.color} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
              <StatusBadge
                tone="neutral"
                label={project.access.role?.name ?? 'Workspace admin'}
                dot={false}
              />
              {project.status === 'ARCHIVED' ? (
                <StatusBadge tone="warning" label="Archived" />
              ) : null}
            </div>
            <p className="font-mono text-xs text-muted-foreground">{project.slug}</p>
          </div>
          <FavoriteToggle
            workspaceId={workspace.id}
            projectId={project.id}
            name={project.name}
            initial={project.isFavorite}
          />
        </div>
      </div>
      {project.status === 'ARCHIVED' ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
        >
          <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            This project is archived and read-only.
            {can('project:archive') ? ' Restore it from Settings to make changes.' : ''}
          </span>
        </div>
      ) : null}
      <WorkspaceTabs tabs={tabs} />
    </>
  );
}
