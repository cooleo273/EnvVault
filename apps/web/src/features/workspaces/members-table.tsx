'use client';

import type { WorkspaceMember, WorkspaceRole } from '@envvault/shared';
import { Users } from 'lucide-react';
import { useState, useTransition } from 'react';
import { DataTable, type DataTableColumn } from '@/components/data/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { reportAction } from '@/lib/action-result';
import { changeMemberRoleAction, leaveWorkspaceAction, removeMemberAction } from './actions';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

export interface MembersTableProps {
  workspaceId: string;
  members: WorkspaceMember[];
  roles: WorkspaceRole[];
  /** The caller's role and permissions (for display; the API enforces). */
  actorRoleKey: string;
  canManage: boolean;
  archived: boolean;
}

function RoleCell({
  workspaceId,
  member,
  roles,
  editable,
  allowOwner,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  roles: WorkspaceRole[];
  editable: boolean;
  allowOwner: boolean;
}) {
  const [value, setValue] = useState(member.role.key);
  const [pending, startTransition] = useTransition();
  if (!editable) return <span>{member.role.name}</span>;
  const options = roles.filter((r) => allowOwner || r.key !== 'owner');
  return (
    <NativeSelect
      aria-label={`Role for ${member.user.displayName ?? member.user.email}`}
      value={value}
      disabled={pending}
      className="h-control-sm w-36"
      onChange={(event) => {
        const next = event.target.value;
        const previous = value;
        setValue(next);
        startTransition(async () => {
          const result = await changeMemberRoleAction(workspaceId, member.id, next);
          if (result.ok) {
            notify.success(result.message ?? 'Role updated.');
          } else {
            setValue(previous);
            notify.error(result.message);
          }
        });
      }}
    >
      {options.map((role) => (
        <option key={role.key} value={role.key}>
          {role.name}
        </option>
      ))}
    </NativeSelect>
  );
}

export function MembersTable({
  workspaceId,
  members,
  roles,
  actorRoleKey,
  canManage,
  archived,
}: MembersTableProps) {
  const actorIsOwner = actorRoleKey === 'owner';
  const ownerCount = members.filter((m) => m.role.key === 'owner').length;

  const canEdit = (member: WorkspaceMember) =>
    canManage &&
    !archived &&
    !member.isCurrentUser &&
    (actorIsOwner || member.role.key !== 'owner');

  const columns: DataTableColumn<WorkspaceMember>[] = [
    {
      id: 'member',
      header: 'Member',
      isRowHeader: true,
      sortValue: (row) => row.user.displayName ?? row.user.email,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-medium">
            <span className="truncate">{row.user.displayName ?? row.user.email}</span>
            {row.isCurrentUser ? <StatusBadge tone="info" label="You" dot={false} /> : null}
          </span>
          {row.user.displayName ? (
            <span className="truncate text-xs text-muted-foreground">{row.user.email}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (row) => ['owner', 'admin', 'member', 'viewer'].indexOf(row.role.key),
      cell: (row) => (
        <RoleCell
          workspaceId={workspaceId}
          member={row}
          roles={roles}
          editable={canEdit(row)}
          allowOwner={actorIsOwner}
        />
      ),
    },
    {
      id: 'joined',
      header: 'Joined',
      hideBelow: 'md',
      sortValue: (row) => new Date(row.joinedAt),
      cell: (row) => dateFormat.format(new Date(row.joinedAt)),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => {
        const name = row.user.displayName ?? row.user.email;
        if (row.isCurrentUser) {
          const lastOwner = row.role.key === 'owner' && ownerCount <= 1;
          return (
            <ConfirmDialog
              title="Leave workspace?"
              description="You will lose access immediately. An admin can invite you again."
              confirmLabel="Leave workspace"
              destructive
              onConfirm={async () => {
                await reportAction(leaveWorkspaceAction(workspaceId));
              }}
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={lastOwner}
                  title={lastOwner ? 'Transfer ownership before leaving' : undefined}
                >
                  Leave
                </Button>
              }
            />
          );
        }
        if (!canEdit(row)) return null;
        const lastOwner = row.role.key === 'owner' && ownerCount <= 1;
        return (
          <ConfirmDialog
            title={`Remove ${name}?`}
            description="They lose access to this workspace immediately. History stays in the audit log."
            confirmLabel="Remove member"
            destructive
            onConfirm={async () => {
              await reportAction(removeMemberAction(workspaceId, row.id));
            }}
            trigger={
              <Button variant="ghost" size="sm" disabled={lastOwner} aria-label={`Remove ${name}`}>
                Remove
              </Button>
            }
          />
        );
      },
    },
  ];

  return (
    <DataTable
      caption="Workspace members"
      columns={columns}
      data={members}
      getRowId={(row) => row.id}
      emptyState={<EmptyState icon={Users} title="No members" />}
    />
  );
}
