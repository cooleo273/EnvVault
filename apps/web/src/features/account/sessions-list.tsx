'use client';

import { Laptop } from 'lucide-react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { StatusBadge } from '@/components/feedback/status-badge';
import { Button } from '@/components/ui/button';
import { reportAction } from '@/lib/action-result';
import { revokeOtherSessionsAction, revokeSessionAction } from './actions';
import type { SessionSummary } from './sessions';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** Very small, dependency-free description of a user agent string. */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Firefox/')
      ? 'Firefox'
      : userAgent.includes('Chrome/')
        ? 'Chrome'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'Browser';
  const os = userAgent.includes('Windows')
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent)
      ? 'macOS'
      : userAgent.includes('Android')
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : userAgent.includes('Linux')
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsList({ sessions }: { sessions: SessionSummary[] }) {
  const others = sessions.filter((s) => !s.current);
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y rounded-md border" aria-label="Active sessions">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <Laptop aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-0.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {describeUserAgent(session.userAgent)}
                  {session.current ? (
                    <StatusBadge tone="success" label="This device" dot={false} />
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  Signed in {dateFormat.format(new Date(session.createdAt))}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ''} · expires{' '}
                  {dateFormat.format(new Date(session.expiresAt))}
                </p>
              </div>
            </div>
            {!session.current && session.revocable ? (
              <ConfirmDialog
                title="Sign out this session?"
                description="That device is signed out and its API access tokens are revoked."
                confirmLabel="Sign out session"
                destructive
                onConfirm={async () => {
                  await reportAction(revokeSessionAction(session.id));
                }}
                trigger={
                  <Button variant="outline" size="sm">
                    Sign out
                  </Button>
                }
              />
            ) : null}
          </li>
        ))}
      </ul>
      {others.length > 0 ? (
        <div className="flex justify-end">
          <ConfirmDialog
            title="Sign out all other sessions?"
            description="Every other device is signed out. This device stays signed in."
            confirmLabel="Sign out others"
            destructive
            onConfirm={async () => {
              await reportAction(revokeOtherSessionsAction());
            }}
            trigger={<Button variant="outline">Sign out other sessions</Button>}
          />
        </div>
      ) : null}
    </div>
  );
}
