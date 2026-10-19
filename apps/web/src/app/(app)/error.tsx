'use client';

import { ErrorState } from '@/components/feedback/states';

/** Route-level error boundary for the dashboard. Never renders raw error messages. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-lg border bg-surface">
      <ErrorState
        title="This page failed to load"
        description="An unexpected error occurred. You can try again; if it keeps happening, contact support with the reference below."
        onRetry={reset}
        {...(error.digest ? { requestId: error.digest } : {})}
      />
    </div>
  );
}
