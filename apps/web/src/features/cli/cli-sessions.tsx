'use client';

import type { CliSession } from '@envvault/shared';
import { Terminal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { revokeCliSessionAction } from './actions';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** CLI sessions of the signed in user, each with a sign out button. */
export function CliSessionsList({ sessions }: { sessions: CliSession[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No CLI is signed in to your account.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="CLI sessions">
      {sessions.map((session) => (
        <li
          key={session.id}
          className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="cli-session"
        >
          <div className="flex items-start gap-3">
            <Terminal aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium break-all">{session.hostname}</p>
              <p className="text-xs text-muted-foreground">
                {session.platform} · CLI {session.clientVersion} · signed in{' '}
                {dateFormat.format(new Date(session.createdAt))}
                {session.lastUsedAt
                  ? ` · last used ${dateFormat.format(new Date(session.lastUsedAt))}`
                  : ''}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === session.id}
            onClick={() => {
              setBusy(session.id);
              void revokeCliSessionAction(session.id)
                .then((result) => {
                  if (result.ok) notify.success(result.message ?? 'Done.');
                  else notify.error(result.message);
                  router.refresh();
                })
                .finally(() => {
                  setBusy(null);
                });
            }}
          >
            Sign out
          </Button>
        </li>
      ))}
    </ul>
  );
}
