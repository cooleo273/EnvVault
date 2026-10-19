'use client';

import type * as React from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export interface ResponsiveModalProps {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Action buttons, rendered in a sticky footer. */
  footer?: React.ReactNode;
  /** Element that opens the modal (uncontrolled usage). */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Modal that renders as a bottom sheet on small screens and a centred dialog
 * on larger ones. Focus is trapped while open, Escape closes it and focus
 * returns to the trigger on close.
 */
export function ResponsiveModal({
  title,
  description,
  children,
  footer,
  trigger,
  open,
  onOpenChange,
  className,
}: ResponsiveModalProps) {
  return (
    <Dialog {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className={className}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <DialogBody>{children}</DialogBody> : null}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
