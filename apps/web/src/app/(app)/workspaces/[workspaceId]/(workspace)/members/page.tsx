import { MailPlus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MembersTable } from '@/features/workspaces/members-table';
import { withApi } from '@/lib/api/server-api';
import { getWorkspace, handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Members' };

export default async function WorkspaceMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ transferred?: string }>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspace(workspaceId);
  const [members, roles] = await withApi((api) =>
    Promise.all([api.listMembers(workspaceId), api.listRoles(workspaceId)]),
  ).catch((error: unknown) => handleApiFailure(error, `/workspaces/${workspaceId}/members`));
  const can = (permission: string) => workspace.permissions.includes(permission);

  return (
    <>
      {query.transferred ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Ownership transferred. You are now an admin of this workspace.
        </p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {members.length} {members.length === 1 ? 'member' : 'members'}.{' '}
          {can('member:manage')
            ? 'Change roles or remove people. Only owners can manage owners.'
            : 'Ask an admin to change roles.'}
        </p>
        {can('member:invite') && !workspace.archivedAt ? (
          <Button asChild>
            <Link href={`/workspaces/${workspaceId}/invitations`}>
              <MailPlus aria-hidden="true" />
              Invite people
            </Link>
          </Button>
        ) : null}
      </div>
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
