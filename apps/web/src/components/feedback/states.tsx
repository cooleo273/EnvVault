import { AlertTriangleIcon, Construction, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/* ---------------------------------------------------------------- EmptyState */

export interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Primary call to action (e.g. a Button). */
  action?: React.ReactNode;
  /**
   * `empty`: the feature works, there is simply no data yet.
   * `placeholder`: the feature is not implemented yet; says so explicitly.
   */
  variant?: 'empty' | 'placeholder';
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  variant = 'empty',
  className,
}: EmptyStateProps) {
  const Icon = icon ?? (variant === 'placeholder' ? Construction : undefined);
  return (
    <div
      data-variant={variant}
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="grid size-10 place-items-center rounded-lg border bg-surface-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </span>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        {variant === 'placeholder' ? (
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Not available yet
          </p>
        ) : null}
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- ErrorState */

export interface ErrorStateProps {
  title?: string;
  description?: React.ReactNode;
  /** Optional retry handler; renders a retry button when provided. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Correlation id to quote to support. Never pass raw error messages. */
  requestId?: string;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'The content could not be loaded. Try again in a moment.',
  onRetry,
  retryLabel = 'Try again',
  requestId,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <span className="grid size-10 place-items-center rounded-lg border border-danger-border bg-danger-subtle text-danger">
        <AlertTriangleIcon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="text-sm text-muted-foreground">{description}</div>
        {requestId ? (
          <p className="text-xs text-muted-foreground">
            Request ID: <code className="font-mono">{requestId}</code>
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring mt-1 inline-flex h-control-sm items-center rounded-md border border-input bg-surface px-3 text-xs font-medium shadow-xs hover:bg-accent"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- LoadingSkeleton */

export interface LoadingSkeletonProps {
  variant?: 'table' | 'list' | 'page' | 'text';
  /** Number of rows/lines for table, list and text variants. */
  rows?: number;
  /** Accessible description announced to screen readers. */
  label?: string;
  className?: string;
}

export function LoadingSkeleton({
  variant = 'list',
  rows = 5,
  label = 'Loading…',
  className,
}: LoadingSkeletonProps) {
  const lines = Array.from({ length: rows }, (_, index) => index);
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn('w-full', className)}>
      <span className="sr-only">{label}</span>
      {variant === 'page' ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : null}
      {variant === 'table' ? (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex h-row-default items-center gap-4 border-b bg-surface-muted px-4">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-1/6" />
            <Skeleton className="h-3 w-1/5" />
          </div>
          {lines.map((line) => (
            <div
              key={line}
              className="flex h-row-default items-center gap-4 border-b px-4 last:border-b-0"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/6" />
              <Skeleton className="h-3 w-1/5" />
            </div>
          ))}
        </div>
      ) : null}
      {variant === 'list' ? (
        <div className="flex flex-col gap-3">
          {lines.map((line) => (
            <div key={line} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {variant === 'text' ? (
        <div className="flex flex-col gap-2">
          {lines.map((line) => (
            <Skeleton key={line} className={cn('h-3', line === rows - 1 ? 'w-2/3' : 'w-full')} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
