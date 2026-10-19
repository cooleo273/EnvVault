'use client';

import { useId, useState } from 'react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

export interface ConfirmDialogProps {
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /**
   * Require typing this exact text before confirming (for irreversible
   * actions such as deleting an environment).
   */
  confirmationText?: string;
  /** May return a promise; the dialog shows a pending state and closes on success. */
  onConfirm: () => void | Promise<void>;
  /** Element that opens the dialog (uncontrolled usage). */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirmationText,
  onConfirm,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputId = useId();
  const open = controlledOpen ?? uncontrolledOpen;

  function setOpen(next: boolean) {
    if (pending) return;
    if (!next) {
      setTyped('');
      setFailed(false);
    }
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const confirmationMatches = confirmationText === undefined || typed === confirmationText;

  async function handleConfirm() {
    if (!confirmationMatches) return;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
      setPending(false);
      setOpen(false);
    } catch {
      // The caller is responsible for reporting details (e.g. via toast).
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <div className="flex flex-col gap-2 px-5 pt-5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          {confirmationText !== undefined ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId} className="font-normal text-muted-foreground">
                Type <code className="font-mono text-foreground">{confirmationText}</code> to
                confirm
              </Label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            </div>
          ) : null}
          {failed ? (
            <p role="alert" className="text-sm text-danger">
              The action could not be completed. Please try again.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t px-5 py-3 sm:flex-row sm:justify-end">
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          {/* Not AlertDialogAction: we close only after onConfirm succeeds. */}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={!confirmationMatches || pending}
            aria-busy={pending}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
