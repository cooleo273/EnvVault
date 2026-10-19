import type * as React from 'react';
import { STATUS_TONE_CLASSES, type StatusTone } from '@/design/tokens';
import { cn } from '@/lib/utils';

export interface StatusBadgeProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  tone: StatusTone;
  /** Visible text. Status is never conveyed by colour alone. */
  label: string;
  /** Show the leading status dot. */
  dot?: boolean;
}

export function StatusBadge({ tone, label, dot = true, className, ...props }: StatusBadgeProps) {
  const classes = STATUS_TONE_CLASSES[tone];
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-px text-2xs font-medium whitespace-nowrap',
        classes.badge,
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', classes.dot)} />
      ) : null}
      {label}
    </span>
  );
}
