import { Archive } from 'lucide-react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { Breadcrumbs } from '@/components/layout/page-header';
import { WorkspaceTabs } from '@/features/workspaces/workspace-tabs';
import { getWorkspace } from '@/lib/workspaces/server';

/**
 * Shared frame for every workspace page. The API returns 404 for
 * non-members, which renders the not-found page: workspace ids in the URL are
 * never trusted as proof of access.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await getWorkspace(workspaceId);
  const can = (permission: string) => workspace.permissions.includes(permission);
  const base = `/workspaces/${workspace.id}`;

  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/members`, label: 'Members' },
    ...(can('member:invite') ? [{ href: `${base}/invitations`, label: 'Invitations' }] : []),
    ...(can('workspace:update') || can('workspace:archive') || can('workspace:delete')
      ? [{ href: `${base}/settings`, label: 'Settings' }]
      : []),
  ];

  return (
    <>
      <div className="flex flex-col gap-3">
        <Breadcrumbs
          items={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspace.name }]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{workspace.name}</h1>
          <StatusBadge tone="neutral" label={workspace.role.name} dot={false} />
          {workspace.archivedAt ? <StatusBadge tone="warning" label="Archived" /> : null}
        </div>
        <p className="font-mono text-xs text-muted-foreground">{workspace.slug}</p>
      </div>
      {workspace.archivedAt ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
        >
          <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            This workspace is archived and read-only.
            {can('workspace:archive') ? ' Restore it from Settings to make changes.' : ''}
          </span>
        </div>
      ) : null}
      <WorkspaceTabs tabs={tabs} />
      {children}
    </>
  );
}
