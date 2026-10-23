'use client';

import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';

/**
 * Password confirmation for CLI commands on protected environments. The
 * confirmation belongs to the person, so the CLI session can use it for
 * the same short window as the browser.
 */
export function CliConfirm() {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (confirmed) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border bg-surface p-5">
        <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
        <p className="text-sm">
          Password confirmed. Run the command again in your terminal within the next few minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-surface p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          A CLI command needs values from a protected environment. Confirm your password here; the
          CLI never asks for it.
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Confirm password
        </Button>
      </div>
      <StepUpDialog
        open={open}
        onOpenChange={setOpen}
        onConfirmed={() => {
          setConfirmed(true);
        }}
        description="Confirm your password to let your CLI read protected values for the next few minutes."
      />
    </div>
  );
}
