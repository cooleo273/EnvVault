import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { STATUS_TONE_CLASSES } from '@/design/tokens';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border px-1.5 py-px text-2xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        success: STATUS_TONE_CLASSES.success.badge,
        warning: STATUS_TONE_CLASSES.warning.badge,
        danger: STATUS_TONE_CLASSES.danger.badge,
        info: STATUS_TONE_CLASSES.info.badge,
        neutral: STATUS_TONE_CLASSES.neutral.badge,
      },
    },
    defaultVariants: {
      variant: 'outline',
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
