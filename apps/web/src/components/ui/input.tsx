import type * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'focus-ring flex h-control w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm shadow-xs transition-colors',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'read-only:bg-surface-muted aria-invalid:border-danger',
        '[&::-webkit-search-cancel-button]:appearance-none',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
