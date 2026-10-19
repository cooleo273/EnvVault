'use client';

import type { ReceivedInvitation } from '@envvault/shared';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { LoadingSkeleton } from '@/components/feedback/states';
import {
  acceptInvitationAction,
  declineInvitationAction,
  type InvitationLookup,
  lookupInvitationAction,
} from './actions';

const STORAGE_KEY = 'envvault.invitation-token';
const RETURN_TO = '/invite';

/**
 * Takes the token from the URL fragment (never sent to servers or in Referer
 * headers), removes it from the address bar, and keeps it in sessionStorage
 * only for the sign-in round trip.
 */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
  try {
    if (fromHash) {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
      window.history.replaceState(null, '', window.location.pathname);
      return fromHash;
    }
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return fromHash;
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing to forget.
  }
}

type View =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'declined' }
  | { kind: 'lookup'; result: InvitationLookup; token: string };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'long' });

function Invitation({ invitation, token }: { invitation: ReceivedInvitation; token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [declined, setDeclined] = useState(false);

  if (declined) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        You declined the invitation to {invitation.workspace.name}.{' '}
        <Link href="/dashboard" className="focus-ring rounded-sm text-brand hover:underline">
          Go to EnvVault
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-2 rounded-md border bg-surface-muted p-3 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="text-muted-foreground">Workspace</dt>
        <dd className="font-medium">{invitation.workspace.name}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>{invitation.role.name}</dd>
        {invitation.invitedBy?.displayName ? (
          <>
            <dt className="text-muted-foreground">Invited by</dt>
            <dd>{invitation.invitedBy.displayName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{dateFormat.format(new Date(invitation.expiresAt))}</dd>
      </dl>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await declineInvitationAction({ token });
              if (result.ok) {
                forgetToken();
                setDeclined(true);
              } else setError(result.message);
            });
          }}
        >
          Decline
        </Button>
        <Button
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            startTransition(async () => {
              forgetToken();
              // Redirects to the workspace on success.
              const result = await acceptInvitationAction({ token });
              if (!result.ok) setError(result.message);
            });
          }}
        >
          {pending ? 'Joining…' : `Join ${invitation.workspace.name}`}
        </Button>
      </div>
    </div>
  );
}

export function InviteAcceptance() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    const token = takeToken();
    void (token ? lookupInvitationAction(token) : Promise.resolve(null)).then((result) => {
      if (!token || !result) {
        setView({ kind: 'missing' });
        return;
      }
      if (result.status === 'error') forgetToken();
      setView({ kind: 'lookup', result, token });
    });
  }, []);

  if (view.kind === 'loading')
    return <LoadingSkeleton variant="text" rows={3} label="Checking invitation…" />;

  if (view.kind === 'missing' || view.kind === 'declined') {
    return (
      <p className="text-sm text-muted-foreground">
        Open the invitation link you received to join a workspace. Links work once and expire after
        7 days.
      </p>
    );
  }

  const { result, token } = view;
  if (result.status === 'signed_out') {
    const next = encodeURIComponent(RETURN_TO);
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Sign in, or create an account, with the email address the invitation was sent to.
        </p>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link href={`/login?redirectTo=${next}`}>Sign in to continue</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/signup?redirectTo=${next}`}>Create an account</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (result.status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {result.message}
        </p>
        <Button asChild variant="outline">
          <Link href="/dashboard">Go to EnvVault</Link>
        </Button>
      </div>
    );
  }
  return <Invitation invitation={result.invitation} token={token} />;
}
