import { ENVIRONMENT_KIND_LABELS, type EnvironmentSummary } from '@envvault/shared';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/feedback/status-badge';
import { EnvironmentIcon } from './visual';

/** EnvironmentCard: compact summary linking to the environment. */
export function EnvironmentCard({
  environment,
  href,
}: {
  environment: EnvironmentSummary;
  href: string;
}) {
  return (
    <li className="relative flex items-start gap-3 rounded-lg border bg-surface p-3 transition-colors hover:border-ring/60">
      <EnvironmentIcon icon={environment.icon} kind={environment.kind} color={environment.color} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          href={href}
          className="focus-ring flex items-center gap-1.5 truncate rounded-sm text-sm font-medium after:absolute after:inset-0 hover:underline"
        >
          {environment.name}
          {environment.isProtected ? (
            <ShieldCheck
              aria-label="Protected"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
        </Link>
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{environment.slug}</span> ·{' '}
          {ENVIRONMENT_KIND_LABELS[environment.kind]}
          {environment.expectedKeyCount > 0
            ? ` · ${String(environment.expectedKeyCount)} expected keys`
            : ''}
        </span>
      </div>
      {environment.status === 'ARCHIVED' ? (
        <StatusBadge tone="warning" label="Archived" dot={false} />
      ) : null}
    </li>
  );
}
