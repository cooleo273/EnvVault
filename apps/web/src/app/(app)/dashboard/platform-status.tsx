import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/feedback/status-badge';
import { PRIMARY_NAV } from '@/config/navigation';
import { getApiStatus } from './api-status';

const MODULE_DESCRIPTIONS: Record<string, string> = {
  '/workspaces': 'Tenants that own projects, members, roles and encryption keys.',
  '/projects': 'Applications and their custom environments.',
  '/members': 'Invitations, workspace roles and project access.',
  '/audit-logs': 'Append-only record of every access and change.',
  '/integrations': 'Sync configuration to CI/CD and cloud platforms.',
  '/notifications': 'Invitations, approvals and rotation reminders.',
};

const timeFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** Live API/database status and the module list (platform-level, not workspace data). */
export async function PlatformStatus() {
  const status = await getApiStatus();

  let databaseBadge = <StatusBadge tone="neutral" label="Unknown" />;
  if (status.databaseReady === true) databaseBadge = <StatusBadge tone="success" label="Ready" />;
  if (status.databaseReady === false)
    databaseBadge = <StatusBadge tone="danger" label="Not ready" />;

  const modules = PRIMARY_NAV.filter((item) => item.href in MODULE_DESCRIPTIONS);

  return (
    <>
      <section aria-labelledby="system-status" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id="system-status" className="text-sm font-semibold">
            System status
          </h2>
          <StatusBadge tone="success" label="Live" dot={false} />
        </div>
        <dl className="divide-y rounded-lg border bg-surface">
          <StatusRow label="API">
            {status.reachable ? (
              <StatusBadge tone="success" label="Operational" />
            ) : (
              <StatusBadge tone="danger" label="Unreachable" />
            )}
          </StatusRow>
          <StatusRow label="Database">{databaseBadge}</StatusRow>
          <StatusRow label="API version">
            <span className="font-mono text-xs">{status.version ?? '—'}</span>
          </StatusRow>
          <StatusRow label="Endpoint">
            <span className="font-mono text-xs break-all">{status.apiOrigin}</span>
          </StatusRow>
          <StatusRow label="Checked">
            <time dateTime={status.checkedAt} className="text-xs text-muted-foreground">
              {timeFormat.format(new Date(status.checkedAt))} UTC
            </time>
          </StatusRow>
        </dl>
        {status.reachable ? null : (
          <p className="text-xs text-muted-foreground">
            Start the API with <code className="font-mono">pnpm dev:api</code> and reload this page.
          </p>
        )}
      </section>

      <section aria-labelledby="modules" className="flex flex-col gap-3">
        <h2 id="modules" className="text-sm font-semibold">
          Modules
        </h2>
        <ul className="divide-y rounded-lg border bg-surface">
          {modules.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="focus-ring flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/60"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="font-medium">{item.label}</span>
                    <span className="truncate text-muted-foreground">
                      {MODULE_DESCRIPTIONS[item.href]}
                    </span>
                  </span>
                  {item.status === 'live' ? (
                    <StatusBadge tone="success" label="Live" dot={false} />
                  ) : (
                    <StatusBadge tone="neutral" label="Preview" dot={false} />
                  )}
                  <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
