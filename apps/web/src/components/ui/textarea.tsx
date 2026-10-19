import type * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'focus-ring flex min-h-20 w-full min-w-0 rounded-md border border-input bg-surface px-3 py-2 text-sm shadow-xs transition-colors',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'read-only:bg-surface-muted aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

/** Native select styled like Input (accessible and works without JavaScript). */
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'focus-ring flex h-control w-full min-w-0 rounded-md border border-input bg-surface px-2.5 text-sm shadow-xs transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect, Textarea };
