import type { ReceivedInvitation, WorkspaceSummary } from '@envvault/shared';
import { PlusIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { ReceivedInvitations } from '@/features/workspaces/received-invitations';
import { withApi } from '@/lib/api/server-api';
import { WorkspacesView } from './workspaces-view';

export const metadata: Metadata = { title: 'Workspaces' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function WorkspacesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  let workspaces: WorkspaceSummary[] | null;
  let invitations: ReceivedInvitation[] = [];
  try {
    [workspaces, invitations] = await withApi((api) =>
      Promise.all([api.listWorkspaces({ includeArchived: true }), api.myInvitations()]),
    );
  } catch {
    workspaces = null;
  }
  const active = workspaces?.filter((w) => !w.archivedAt) ?? null;
  const archived = workspaces?.filter((w) => w.archivedAt) ?? [];

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Each workspace is an isolated tenant with its own projects, members, roles and encryption keys."
        status="live"
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Workspaces' }]}
        actions={
          <Button asChild>
            <Link href="/workspaces/new">
              <PlusIcon aria-hidden="true" />
              New workspace
            </Link>
          </Button>
        }
      />
      {params.deleted ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Workspace deleted. It can be recovered by an administrator during the recovery window.
        </p>
      ) : null}

      {invitations.length > 0 ? (
        <section
          id="invitations"
          aria-labelledby="invitations-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="invitations-heading" className="text-sm font-semibold">
            Invitations for you
          </h2>
          <ReceivedInvitations invitations={invitations} />
        </section>
      ) : null}

      <WorkspacesView workspaces={active} />

      {archived.length > 0 ? (
        <section aria-labelledby="archived-heading" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id="archived-heading" className="text-sm font-semibold">
              Archived
            </h2>
            <p className="text-xs text-muted-foreground">
              Read-only until an owner restores them. Not shown in the workspace switcher.
            </p>
          </div>
          <WorkspacesView workspaces={archived} caption="Archived workspaces" />
        </section>
      ) : null}
    </>
  );
}
