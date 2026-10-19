'use client';

import { XIcon } from 'lucide-react';
import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const overlayClasses = 'fixed inset-0 z-50 bg-overlay';

/**
 * Responsive panel: a bottom sheet on small screens, a centred dialog from
 * `sm` up. One component, no JS media queries, so SSR and hydration match.
 */
const panelClasses = cn(
  'fixed z-50 flex max-h-[90dvh] flex-col border bg-popover text-popover-foreground shadow-overlay focus:outline-none',
  'inset-x-0 bottom-0 rounded-t-xl',
  'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
);

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClasses} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(panelClasses, className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="focus-ring absolute top-3 right-3 inline-flex size-control-sm items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <XIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5 pr-12', className)} {...props} />;
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t px-5 py-3 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold', className)} {...props} />;
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

/* Alert dialog: same visuals, but no outside-click dismissal and focus starts on Cancel. */
const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogTitle = DialogTitleFor(AlertDialogPrimitive.Title);
const AlertDialogDescription = DialogDescriptionFor(AlertDialogPrimitive.Description);
const AlertDialogCancel = AlertDialogPrimitive.Cancel;
const AlertDialogAction = AlertDialogPrimitive.Action;

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={overlayClasses} />
      <AlertDialogPrimitive.Content className={cn(panelClasses, className)} {...props} />
    </AlertDialogPrimitive.Portal>
  );
}

function DialogTitleFor(Title: typeof AlertDialogPrimitive.Title) {
  return function Component({ className, ...props }: React.ComponentProps<typeof Title>) {
    return <Title className={cn('text-base font-semibold', className)} {...props} />;
  };
}

function DialogDescriptionFor(Description: typeof AlertDialogPrimitive.Description) {
  return function Component({ className, ...props }: React.ComponentProps<typeof Description>) {
    return <Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
  };
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
