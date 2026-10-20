import type { Metadata } from 'next';
import Link from 'next/link';
import { StatusBadge } from '@/components/feedback/status-badge';
import { getWorkspace } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Workspace' };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'long' });

export default async function WorkspaceOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ created?: string; joined?: string }>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspace(workspaceId);
  const base = `/workspaces/${workspace.id}`;

  return (
    <>
      {query.created || query.joined ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          {query.created
            ? 'Workspace created. You are its owner.'
            : `You joined ${workspace.name} as ${workspace.role.name}.`}
        </p>
      ) : null}

      {workspace.description ? (
        <p className="max-w-2xl text-sm text-muted-foreground">{workspace.description}</p>
      ) : null}

      <dl className="grid divide-y rounded-lg border bg-surface sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {[
          [
            'Members',
            <Link
              key="m"
              href={`${base}/members`}
              className="focus-ring rounded-sm hover:underline"
            >
              {workspace.memberCount}
            </Link>,
          ],
          [
            'Projects',
            <span key="p" className="flex items-center gap-2">
              {workspace.projectCount}
              <StatusBadge tone="neutral" label="Preview" dot={false} />
            </span>,
          ],
          ['Type', workspace.type === 'PERSONAL' ? 'Personal' : 'Team'],
          ['Created', dateFormat.format(new Date(workspace.createdAt))],
        ].map(([label, value], index) => (
          <div key={index} className="flex flex-col gap-1 px-4 py-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="access-heading" className="flex flex-col gap-3">
        <h2 id="access-heading" className="text-sm font-semibold">
          Your access
        </h2>
        <div className="rounded-lg border bg-surface px-4 py-3 text-sm">
          <p>
            You are{' '}
            {workspace.role.name === 'Admin' || workspace.role.name === 'Owner' ? 'an' : 'a'}{' '}
            <strong className="font-medium">{workspace.role.name}</strong> of this workspace.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Workspace roles never grant access to secret values. Project and environment access is
            granted separately once projects are available.
          </p>
        </div>
      </section>
    </>
  );
}
