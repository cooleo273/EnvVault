import { MailPlus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { MembersTable } from '@/features/workspaces/members-table';
import { withApi } from '@/lib/api/server-api';
import { resolveLanding } from '@/lib/workspaces/landing';
import { getMe, getWorkspace, handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Team Members' };

/** Members of the active workspace (switch workspaces from the header). */
export default async function TeamMembersPage() {
  const me = await getMe();
  if (!me) {
    return (
      <>
        <PageHeader title="Team Members" />
        <div className="rounded-lg border bg-surface">
          <ErrorState
            title="Members could not be loaded"
            description="The EnvVault API is unavailable. Try again shortly."
          />
        </div>
      </>
    );
  }
  const landing = resolveLanding(me);
  if (landing.kind === 'onboarding') redirect('/onboarding');

  const workspaceId = landing.workspaceId;
  const workspace = await getWorkspace(workspaceId);
  const [members, roles] = await withApi((api) =>
    Promise.all([api.listMembers(workspaceId), api.listRoles(workspaceId)]),
  ).catch((error: unknown) => handleApiFailure(error, '/members'));
  const can = (permission: string) => workspace.permissions.includes(permission);

  return (
    <>
      <PageHeader
        title="Team Members"
        description={
          <>
            People in <strong className="font-medium text-foreground">{workspace.name}</strong> and
            their roles. Use the workspace switcher above to see another workspace.
          </>
        }
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Team Members' }]}
        status="live"
        actions={
          can('member:invite') && !workspace.archivedAt ? (
            <Button asChild>
              <Link href={`/workspaces/${workspaceId}/invitations`}>
                <MailPlus aria-hidden="true" />
                Invite people
              </Link>
            </Button>
          ) : null
        }
      />
      <p className="text-sm text-muted-foreground">
        {members.length} {members.length === 1 ? 'member' : 'members'}.{' '}
        {can('member:manage')
          ? 'Change roles or remove people. Only owners can manage owners.'
          : 'Ask an admin to change roles.'}
      </p>
      <MembersTable
        workspaceId={workspaceId}
        members={members}
        roles={roles}
        actorRoleKey={workspace.role.key}
        canManage={can('member:manage')}
        archived={workspace.archivedAt !== null}
      />
    </>
  );
}
