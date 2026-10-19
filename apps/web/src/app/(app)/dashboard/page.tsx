import { ArrowRight, Building2, Mail, Settings, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { ErrorState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { ReceivedInvitations } from '@/features/workspaces/received-invitations';
import { withApi } from '@/lib/api/server-api';
import { resolveLanding } from '@/lib/workspaces/landing';
import { getMe, getWorkspace } from '@/lib/workspaces/server';
import { PlatformStatus } from './platform-status';

export const metadata: Metadata = { title: 'Overview' };

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof Users;
  title: string;
  description: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="focus-ring flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/60"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        </span>
        <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </Link>
    </li>
  );
}

/**
 * Landing page after sign-in: the active workspace (restored from the last
 * selection if the user still has access), or onboarding when there is none.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string; left?: string }>;
}) {
  await connection();
  const params = await searchParams;
  const me = await getMe();

  if (!me) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="rounded-lg border bg-surface">
          <ErrorState
            title="Your workspaces could not be loaded"
            description="The EnvVault API is unavailable. Try again shortly."
          />
        </div>
        <PlatformStatus />
      </>
    );
  }

  const landing = resolveLanding(me);
  if (landing.kind === 'onboarding') redirect('/onboarding');

  const [workspace, invitations] = await Promise.all([
    getWorkspace(landing.workspaceId),
    me.pendingInvitationCount > 0
      ? withApi((api) => api.myInvitations()).catch(() => [])
      : Promise.resolve([]),
  ]);
  const can = (permission: string) => workspace.permissions.includes(permission);
  const base = `/workspaces/${workspace.id}`;

  return (
    <>
      <PageHeader
        title={workspace.name}
        description={
          workspace.description ??
          `Your ${workspace.type === 'PERSONAL' ? 'personal' : 'team'} workspace.`
        }
        breadcrumbs={[{ label: 'Overview' }]}
        status="live"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/workspaces">
                <Building2 aria-hidden="true" />
                All workspaces
              </Link>
            </Button>
            <Button asChild>
              <Link href={base}>Open workspace</Link>
            </Button>
          </>
        }
      />

      {params.welcome ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Your workspace is ready. Invite teammates or explore the settings below.
        </p>
      ) : null}
      {params.left ? (
        <p role="status" className="rounded-md border bg-surface-muted px-3 py-2 text-sm">
          You left the workspace. Showing another workspace you belong to.
        </p>
      ) : null}

      <dl className="grid divide-y rounded-lg border bg-surface sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <Stat label="Your role" value={workspace.role.name} />
        <Stat label="Members" value={workspace.memberCount} />
        <Stat
          label="Projects"
          value={
            <span className="flex items-center gap-2">
              {workspace.projectCount}
              <StatusBadge tone="neutral" label="Preview" dot={false} />
            </span>
          }
        />
        <Stat label="Type" value={workspace.type === 'PERSONAL' ? 'Personal' : 'Team'} />
      </dl>

      {invitations.length > 0 ? (
        <section aria-labelledby="invitations-for-you" className="flex flex-col gap-3">
          <h2 id="invitations-for-you" className="text-sm font-semibold">
            Invitations for you
          </h2>
          <ReceivedInvitations invitations={invitations} />
        </section>
      ) : null}

      <section aria-labelledby="quick-actions" className="flex flex-col gap-3">
        <h2 id="quick-actions" className="text-sm font-semibold">
          Workspace
        </h2>
        <ul className="divide-y rounded-lg border bg-surface">
          <QuickLink
            href={`${base}/members`}
            icon={Users}
            title="Members"
            description="People in this workspace and their roles."
          />
          {can('member:invite') ? (
            <QuickLink
              href={`${base}/invitations`}
              icon={Mail}
              title="Invitations"
              description="Invite people and manage pending invitations."
            />
          ) : null}
          {can('workspace:update') ? (
            <QuickLink
              href={`${base}/settings`}
              icon={Settings}
              title="Settings"
              description="Name, description, archiving and ownership."
            />
          ) : null}
        </ul>
      </section>

      <PlatformStatus />
    </>
  );
}
