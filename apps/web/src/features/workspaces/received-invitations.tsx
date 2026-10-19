'use client';

import type { ReceivedInvitation } from '@envvault/shared';
import { Mail } from 'lucide-react';
import { useState, useTransition } from 'react';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { acceptInvitationAction, declineInvitationAction } from './actions';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/** Invitations addressed to the signed-in user (accepted in-app, by id). */
export function ReceivedInvitations({ invitations }: { invitations: ReceivedInvitation[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [, startTransition] = useTransition();
  const visible = invitations.filter((i) => !hidden.includes(i.id));
  if (visible.length === 0) return null;

  function run(id: string, kind: 'accept' | 'decline') {
    setPendingId(id);
    startTransition(async () => {
      const result =
        kind === 'accept'
          ? await acceptInvitationAction({ id })
          : await declineInvitationAction({ id });
      setPendingId(null);
      if (!result.ok) {
        notify.error(result.message);
        return;
      }
      if (result.message) notify.success(result.message);
      setHidden((current) => [...current, id]);
    });
  }

  return (
    <ul className="divide-y rounded-lg border bg-surface" aria-label="Invitations for you">
      {visible.map((invitation) => (
        <li
          key={invitation.id}
          className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-surface-muted text-muted-foreground">
              <Mail aria-hidden="true" className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="truncate text-sm font-medium">{invitation.workspace.name}</p>
              <p className="text-xs text-muted-foreground">
                {invitation.invitedBy?.displayName
                  ? `${invitation.invitedBy.displayName} invited you as ${invitation.role.name}`
                  : `Invited as ${invitation.role.name}`}
                {' · '}expires {dateFormat.format(new Date(invitation.expiresAt))}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pendingId !== null}
              onClick={() => {
                run(invitation.id, 'decline');
              }}
            >
              Decline
            </Button>
            <Button
              size="sm"
              disabled={pendingId !== null}
              aria-busy={pendingId === invitation.id}
              aria-label={`Accept invitation to ${invitation.workspace.name}`}
              onClick={() => {
                run(invitation.id, 'accept');
              }}
            >
              {pendingId === invitation.id ? 'Joining…' : 'Accept'}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
