'use client';

import type { InvitationStatus, WorkspaceInvitation } from '@envvault/shared';
import { MailWarning, Send } from 'lucide-react';
import { useActionState, useState, useTransition } from 'react';
import { DataTable, type DataTableColumn } from '@/components/data/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { CopyField } from '@/components/forms/copy-field';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/textarea';
import type { StatusTone } from '@/design/tokens';
import { reportAction } from '@/lib/action-result';
import { INITIAL_FORM_STATE } from '@/lib/form-state';
import {
  type InviteFormState,
  inviteMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
} from './actions';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

const STATUS: Record<InvitationStatus, { tone: StatusTone; label: string }> = {
  PENDING: { tone: 'info', label: 'Pending' },
  ACCEPTED: { tone: 'success', label: 'Accepted' },
  DECLINED: { tone: 'neutral', label: 'Declined' },
  REVOKED: { tone: 'neutral', label: 'Revoked' },
  EXPIRED: { tone: 'warning', label: 'Expired' },
};

const ROLE_OPTIONS = [
  { key: 'member', name: 'Member' },
  { key: 'viewer', name: 'Viewer' },
  { key: 'admin', name: 'Admin' },
];

/** The one-time link, shown only because email delivery is not configured. */
function ShareLink({ email, url }: { email: string; url: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning-border bg-warning-subtle p-3">
      <p className="flex items-start gap-2 text-sm text-warning">
        <MailWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Email delivery is not configured, so nothing was sent to {email}. Share this link with
          them directly. It is shown only once, works once, and only for {email}.
        </span>
      </p>
      <CopyField label="Invitation link" value={url} />
    </div>
  );
}

function InviteForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState(
    inviteMemberAction.bind(null, workspaceId),
    INITIAL_FORM_STATE as InviteFormState,
  );
  const fieldError = (name: string) => {
    const message = state.fieldErrors?.[name];
    return message ? { error: message } : {};
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        action={action}
        className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-start"
        noValidate
      >
        <FormField label="Email address" {...fieldError('email')}>
          {(control) => (
            <Input
              {...control}
              name="email"
              type="email"
              autoComplete="off"
              placeholder="teammate@company.com"
              required
            />
          )}
        </FormField>
        <FormField label="Role" {...fieldError('roleKey')}>
          {(control) => (
            <NativeSelect {...control} name="roleKey" defaultValue="member">
              {ROLE_OPTIONS.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <Button type="submit" disabled={pending} aria-busy={pending} className="sm:mt-6">
          <Send aria-hidden="true" />
          {pending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>
      {state.message ? (
        <p
          role={state.status === 'error' ? 'alert' : 'status'}
          className={
            state.status === 'error'
              ? 'rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger'
              : 'text-sm text-muted-foreground'
          }
        >
          {state.message}
        </p>
      ) : null}
      {state.status === 'success' && state.issued?.acceptUrl ? (
        <ShareLink email={state.issued.email} url={state.issued.acceptUrl} />
      ) : null}
    </div>
  );
}

export function InvitationsPanel({
  workspaceId,
  invitations,
  emailConfigured,
}: {
  workspaceId: string;
  invitations: WorkspaceInvitation[];
  emailConfigured: boolean;
}) {
  const [resent, setResent] = useState<{ email: string; url: string } | null>(null);
  const [busy, startTransition] = useTransition();

  const columns: DataTableColumn<WorkspaceInvitation>[] = [
    {
      id: 'email',
      header: 'Email',
      isRowHeader: true,
      sortValue: (row) => row.email,
      cell: (row) => <span className="font-medium break-all">{row.email}</span>,
    },
    { id: 'role', header: 'Role', sortValue: (row) => row.role.name, cell: (row) => row.role.name },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status,
      cell: (row) => (
        <StatusBadge tone={STATUS[row.status].tone} label={STATUS[row.status].label} />
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      hideBelow: 'md',
      sortValue: (row) => new Date(row.expiresAt),
      cell: (row) => dateFormat.format(new Date(row.expiresAt)),
    },
    {
      id: 'invitedBy',
      header: 'Invited by',
      hideBelow: 'lg',
      cell: (row) => row.invitedBy?.displayName ?? row.invitedBy?.email ?? '—',
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          {row.status === 'PENDING' || row.status === 'EXPIRED' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`Resend invitation to ${row.email}`}
              onClick={() => {
                startTransition(async () => {
                  const result = await resendInvitationAction(workspaceId, row.id);
                  if (!result.ok) {
                    notify.error(result.message);
                    return;
                  }
                  notify.success(result.message ?? 'Invitation renewed.');
                  setResent(result.acceptUrl ? { email: row.email, url: result.acceptUrl } : null);
                });
              }}
            >
              Resend
            </Button>
          ) : null}
          {row.status === 'PENDING' ? (
            <ConfirmDialog
              title="Revoke invitation?"
              description={`The link sent to ${row.email} stops working immediately.`}
              confirmLabel="Revoke"
              destructive
              onConfirm={async () => {
                await reportAction(revokeInvitationAction(workspaceId, row.id));
              }}
              trigger={
                <Button variant="ghost" size="sm" aria-label={`Revoke invitation to ${row.email}`}>
                  Revoke
                </Button>
              }
            />
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="invite-heading" className="rounded-lg border bg-surface">
        <div className="flex flex-col gap-1 border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 id="invite-heading" className="text-sm font-semibold">
              Invite people
            </h2>
            {emailConfigured ? null : (
              <StatusBadge tone="warning" label="Email not configured" dot={false} />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Invitations expire after 7 days and can be used once, by the invited address only.
          </p>
        </div>
        <div className="px-5 py-5">
          <InviteForm workspaceId={workspaceId} />
        </div>
      </section>

      {resent ? <ShareLink email={resent.email} url={resent.url} /> : null}

      <section aria-labelledby="invitations-heading" className="flex flex-col gap-3">
        <h2 id="invitations-heading" className="text-sm font-semibold">
          Invitations
        </h2>
        <DataTable
          caption="Workspace invitations"
          columns={columns}
          data={invitations}
          getRowId={(row) => row.id}
          initialSort={{ columnId: 'expires', direction: 'desc' }}
          emptyState={
            <EmptyState
              icon={Send}
              title="No invitations yet"
              description="Invite teammates by email to give them access to this workspace."
            />
          }
        />
      </section>
    </div>
  );
}
