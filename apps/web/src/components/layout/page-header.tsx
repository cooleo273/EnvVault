import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type * as React from 'react';
import { StatusBadge } from '@/components/feedback/status-badge';
import type { FeatureStatus } from '@/config/navigation';
import { cn } from '@/lib/utils';

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page. */
  href?: string;
}

export function Breadcrumbs({
  items,
  className,
}: {
  items: readonly BreadcrumbItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${String(index)}`} className="flex items-center gap-1">
              {item.href && !isLast ? (
                <Link href={item.href} className="focus-ring rounded-sm hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={cn(isLast && 'text-foreground')}
                >
                  {item.label}
                </span>
              )}
              {isLast ? null : <ChevronRight aria-hidden="true" className="size-3" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  breadcrumbs?: readonly BreadcrumbItem[];
  /** Context-specific primary (and secondary) actions. */
  actions?: React.ReactNode;
  /** Marks whether the page shows live data or is a preview of a future feature. */
  status?: FeatureStatus;
}

export function PageHeader({ title, description, breadcrumbs, actions, status }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 border-b pb-5">
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {status === 'preview' ? <StatusBadge tone="neutral" label="Preview" /> : null}
            {status === 'live' ? <StatusBadge tone="success" label="Live" /> : null}
          </div>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
