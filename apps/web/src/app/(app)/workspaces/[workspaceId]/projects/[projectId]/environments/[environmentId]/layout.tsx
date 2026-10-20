import { ENVIRONMENT_KIND_LABELS, type EnvironmentSummary } from '@envvault/shared';
import { Archive, ShieldCheck } from 'lucide-react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { EnvironmentSelector } from '@/features/projects/environment-selector';
import { EnvironmentIcon } from '@/features/projects/visual';
import { WorkspaceTabs } from '@/features/workspaces/workspace-tabs';
import { withApi } from '@/lib/api/server-api';
import { environmentPath, getEnvironment, projectPath } from '@/lib/projects/server';

/** Environment frame: identity, protection status, switcher and tabs. */
export default async function EnvironmentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
}) {
  const { workspaceId, projectId, environmentId } = await params;
  const [environment, siblings] = await Promise.all([
    getEnvironment(workspaceId, projectId, environmentId),
    withApi((api) => api.listEnvironments(workspaceId, projectId, { status: 'all', pageSize: 200 }))
      .then((r) => r.items)
      .catch(() => [] as EnvironmentSummary[]),
  ]);
  const base = environmentPath(workspaceId, projectId, environmentId);
  const can = (p: string) => environment.permissions.includes(p);
  const tabs = [
    { href: base, label: 'Overview' },
    ...(can('environment:update') || can('environment:protect') || can('access_policy:manage')
      ? [{ href: `${base}/settings`, label: 'Settings' }]
      : []),
  ];

  return (
    <section
      aria-labelledby="environment-name"
      className="flex flex-col gap-4 rounded-lg border bg-surface-muted/40 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <EnvironmentIcon
          icon={environment.icon}
          kind={environment.kind}
          color={environment.color}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="environment-name" className="truncate text-lg font-semibold tracking-tight">
              {environment.name}
            </h2>
            <StatusBadge
              tone="neutral"
              label={ENVIRONMENT_KIND_LABELS[environment.kind]}
              dot={false}
            />
            {environment.isProtected ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-warning-border bg-warning-subtle px-1.5 py-px text-2xs font-medium text-warning">
                <ShieldCheck aria-hidden="true" className="size-3" />
                Protected
              </span>
            ) : null}
            {environment.status === 'ARCHIVED' ? (
              <StatusBadge tone="warning" label="Archived" />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{environment.slug}</span>
            {environment.description ? ` · ${environment.description}` : ''}
          </p>
        </div>
        <EnvironmentSelector
          environments={siblings}
          currentId={environment.id}
          baseHref={`${projectPath(workspaceId, projectId)}/environments`}
        />
      </div>
      {environment.status === 'ARCHIVED' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-warning">
          <Archive aria-hidden="true" className="size-4" />
          This environment is archived and read-only.
        </p>
      ) : null}
      <WorkspaceTabs tabs={tabs} />
      {children}
    </section>
  );
}
